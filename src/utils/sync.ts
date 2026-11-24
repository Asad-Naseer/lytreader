import localforage from "localforage";
import ePub from "epubjs";
import type { Dropbox, files } from "dropbox";
import type { Book } from "../App";
import {
  getDropboxClient,
  clearDropboxAuth,
  DropboxAuthError,
} from "./dropbox";

const DROPBOX_BOOKS_DIR = "/lytreader/books";
const DROPBOX_DATA_PATH = "/lytreader/data.json";
const SYNC_META_KEY = "lytreader-sync-meta";

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB chunks for >140 MB EPUBs
const SINGLE_UPLOAD_LIMIT = 140 * 1024 * 1024;

export interface SyncHighlight {
  cfi: string;
  text: string;
  chapter?: string;
  percentage?: number;
  createdAt: number;
  deletedAt?: number;
}

export interface SyncBookState {
  name?: string;
  progress?: {
    cfi: string;
    updatedAt: number;
  };
  highlights: SyncHighlight[];
}

export interface SyncSettings {
  fontSize?: {
    value: number;
    updatedAt: number;
  };
  theme?: {
    value: "dark" | "light";
    updatedAt: number;
  };
}

export interface CloudData {
  version: 1;
  settings: SyncSettings;
  books: Record<string, SyncBookState>;
}

interface LocalSyncMeta {
  progressUpdatedAt: Record<string, number>;
  deletedHighlights: Record<string, Record<string, number>>;
  fontSizeUpdatedAt: number;
  themeUpdatedAt: number;
}

interface StoredHighlightItem {
  cfi: string;
  text: string;
  chapter?: string;
  percentage?: number;
  createdAt?: number;
}

export interface SyncResult {
  uploadedBooksCount: number;
  downloadedBooks: Book[];
  metadataChanged: boolean;
}

const DEFAULT_META: LocalSyncMeta = {
  progressUpdatedAt: {},
  deletedHighlights: {},
  fontSizeUpdatedAt: 0,
  themeUpdatedAt: 0,
};

// Serialize local sync-meta updates so rapid scrolled `relocated` events never race
let metaWriteQueue: Promise<void> = Promise.resolve();

const getSyncMeta = async (): Promise<LocalSyncMeta> => {
  const saved = await localforage.getItem<LocalSyncMeta>(SYNC_META_KEY);
  return {
    progressUpdatedAt: { ...(saved?.progressUpdatedAt ?? {}) },
    deletedHighlights: { ...(saved?.deletedHighlights ?? {}) },
    fontSizeUpdatedAt: saved?.fontSizeUpdatedAt ?? 0,
    themeUpdatedAt: saved?.themeUpdatedAt ?? 0,
  };
};

const updateSyncMeta = (updater: (meta: LocalSyncMeta) => void): Promise<void> => {
  metaWriteQueue = metaWriteQueue
    .then(async () => {
      const meta = await getSyncMeta();
      updater(meta);
      await localforage.setItem(SYNC_META_KEY, meta);
    })
    .catch((err) => {
      console.error("Failed to update sync metadata:", err);
    });
  return metaWriteQueue;
};

export const touchProgressMeta = (bookId: string): Promise<void> => {
  const now = Date.now();
  return updateSyncMeta((meta) => {
    meta.progressUpdatedAt[bookId] = now;
  });
};

export const recordHighlightTombstone = (
  bookId: string,
  cfi: string,
): Promise<void> => {
  const now = Date.now();
  return updateSyncMeta((meta) => {
    if (!meta.deletedHighlights[bookId]) {
      meta.deletedHighlights[bookId] = {};
    }
    meta.deletedHighlights[bookId][cfi] = now;
  });
};

export const clearHighlightTombstone = (
  bookId: string,
  cfi: string,
): Promise<void> => {
  return updateSyncMeta((meta) => {
    if (meta.deletedHighlights[bookId]) {
      delete meta.deletedHighlights[bookId][cfi];
    }
  });
};

export const touchSettingsMeta = (
  setting: "fontSize" | "theme",
): Promise<void> => {
  const now = Date.now();
  return updateSyncMeta((meta) => {
    if (setting === "fontSize") {
      meta.fontSizeUpdatedAt = now;
    } else {
      meta.themeUpdatedAt = now;
    }
  });
};

const isDropboxNotFoundError = (err: unknown): boolean => {
  const e = err as any;
  if (e?.status !== 409) return false;
  const summary: string = e?.error?.error_summary ?? "";
  if (summary.includes("not_found")) return true;
  const inner = e?.error?.error ?? e?.error;
  return (
    inner?.path?.[".tag"] === "not_found" ||
    inner?.path_lookup?.[".tag"] === "not_found"
  );
};

const isDropboxConflictError = (err: unknown): boolean => {
  const e = err as any;
  if (e?.status !== 409) return false;
  const summary: string = e?.error?.error_summary ?? "";
  if (summary.includes("conflict")) return true;
  const inner = e?.error?.error ?? e?.error;
  return inner?.[".tag"] === "path" && inner?.reason?.[".tag"] === "conflict";
};

const handleAuthFailureIfAny = (err: unknown): never => {
  const e = err as any;
  if (e instanceof DropboxAuthError) {
    throw e;
  }
  if (e?.status === 401) {
    clearDropboxAuth();
    throw new DropboxAuthError("Dropbox session expired. Please reconnect Dropbox.");
  }
  throw err;
};

const readDownloadedBlob = (result: any): Blob => {
  if (result.fileBlob instanceof Blob) return result.fileBlob;
  if (result.fileBinary instanceof Blob) return result.fileBinary;
  return new Blob([result.fileBinary]);
};

const canonicalEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, idx) => canonicalEqual(item, b[idx]));
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined);
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined);
  if (keysA.length !== keysB.length) return false;

  return keysA.every(
    (k) => Object.prototype.hasOwnProperty.call(objB, k) && canonicalEqual(objA[k], objB[k]),
  );
};

const buildLocalCloudData = async (): Promise<{
  localData: CloudData;
  localBooks: Record<string, Book>;
  localProgress: Record<string, string>;
  localHighlights: Record<string, StoredHighlightItem[]>;
  localFontSize: number | null;
  localTheme: "dark" | "light" | null;
  meta: LocalSyncMeta;
}> => {
  await metaWriteQueue;
  const meta = await getSyncMeta();
  const keys = await localforage.keys();

  const localBooks: Record<string, Book> = {};
  const localProgress: Record<string, string> = {};
  const localHighlights: Record<string, StoredHighlightItem[]> = {};
  let localFontSize: number | null = null;
  let localTheme: "dark" | "light" | null = null;

  await Promise.all(
    keys.map(async (key) => {
      if (key.startsWith("book-")) {
        const book = await localforage.getItem<Book>(key);
        if (book) localBooks[key] = book;
      } else if (key.startsWith("progress-")) {
        const cfi = await localforage.getItem<string>(key);
        if (cfi) localProgress[key.slice("progress-".length)] = cfi;
      } else if (key.startsWith("highlights-")) {
        const list = await localforage.getItem<StoredHighlightItem[]>(key);
        if (Array.isArray(list)) {
          localHighlights[key.slice("highlights-".length)] = list;
        }
      } else if (key === "reader-font-size") {
        const fs = await localforage.getItem<number>(key);
        if (typeof fs === "number") localFontSize = fs;
      } else if (key === "reader-theme") {
        const th = await localforage.getItem<"dark" | "light">(key);
        if (th === "dark" || th === "light") localTheme = th;
      }
    }),
  );

  const bookIds = new Set<string>([
    ...Object.keys(localBooks),
    ...Object.keys(localProgress),
    ...Object.keys(localHighlights),
    ...Object.keys(meta.deletedHighlights),
  ]);

  const books: Record<string, SyncBookState> = {};
  for (const id of Array.from(bookIds).sort()) {
    const hlMap = new Map<string, SyncHighlight>();
    for (const hl of localHighlights[id] ?? []) {
      hlMap.set(hl.cfi, {
        cfi: hl.cfi,
        text: hl.text,
        ...(hl.chapter !== undefined ? { chapter: hl.chapter } : {}),
        ...(hl.percentage !== undefined ? { percentage: hl.percentage } : {}),
        createdAt: hl.createdAt ?? 0,
      });
    }

    const deletedMap = meta.deletedHighlights[id] ?? {};
    for (const [cfi, deletedAt] of Object.entries(deletedMap)) {
      const existing = hlMap.get(cfi);
      if (!existing || deletedAt >= existing.createdAt) {
        hlMap.set(cfi, {
          cfi,
          text: "",
          createdAt: existing?.createdAt ?? 0,
          deletedAt,
        });
      }
    }

    const highlights = Array.from(hlMap.values()).sort((a, b) =>
      a.cfi.localeCompare(b.cfi),
    );

    const progressCfi = localProgress[id];
    const bookName = localBooks[id]?.name;

    books[id] = {
      ...(bookName ? { name: bookName } : {}),
      ...(progressCfi
        ? {
            progress: {
              cfi: progressCfi,
              updatedAt: meta.progressUpdatedAt[id] ?? 0,
            },
          }
        : {}),
      highlights,
    };
  }

  const settings: SyncSettings = {};
  if (localFontSize !== null) {
    settings.fontSize = {
      value: localFontSize,
      updatedAt: meta.fontSizeUpdatedAt ?? 0,
    };
  }
  if (localTheme !== null) {
    settings.theme = {
      value: localTheme,
      updatedAt: meta.themeUpdatedAt ?? 0,
    };
  }

  return {
    localData: {
      version: 1,
      settings,
      books,
    },
    localBooks,
    localProgress,
    localHighlights,
    localFontSize,
    localTheme,
    meta,
  };
};

const mergeCloudData = (
  local: CloudData,
  remote: CloudData | null,
): CloudData => {
  if (!remote) return local;

  const settings: SyncSettings = {};

  if (local.settings.fontSize || remote.settings?.fontSize) {
    const l = local.settings.fontSize;
    const r = remote.settings?.fontSize;
    if (!l) {
      settings.fontSize = r;
    } else if (!r) {
      settings.fontSize = l;
    } else {
      settings.fontSize = l.updatedAt > r.updatedAt ? l : r;
    }
  }

  if (local.settings.theme || remote.settings?.theme) {
    const l = local.settings.theme;
    const r = remote.settings?.theme;
    if (!l) {
      settings.theme = r;
    } else if (!r) {
      settings.theme = l;
    } else {
      settings.theme = l.updatedAt > r.updatedAt ? l : r;
    }
  }

  const allBookIds = Array.from(
    new Set([...Object.keys(local.books), ...Object.keys(remote.books ?? {})]),
  ).sort();

  const mergedBooks: Record<string, SyncBookState> = {};

  for (const id of allBookIds) {
    const lBook = local.books[id];
    const rBook = remote.books?.[id];

    const name = rBook?.name || lBook?.name;

    let progress: SyncBookState["progress"];
    if (lBook?.progress && rBook?.progress) {
      progress =
        lBook.progress.updatedAt > rBook.progress.updatedAt
          ? lBook.progress
          : rBook.progress;
    } else {
      progress = rBook?.progress || lBook?.progress;
    }

    const byCfi = new Map<
      string,
      { l?: SyncHighlight; r?: SyncHighlight }
    >();
    for (const h of rBook?.highlights ?? []) {
      byCfi.set(h.cfi, { r: h });
    }
    for (const h of lBook?.highlights ?? []) {
      const pair = byCfi.get(h.cfi) ?? {};
      pair.l = h;
      byCfi.set(h.cfi, pair);
    }

    const mergedHighlights: SyncHighlight[] = [];
    for (const cfi of Array.from(byCfi.keys()).sort()) {
      const { l, r } = byCfi.get(cfi)!;
      if (!l) {
        mergedHighlights.push(r!);
        continue;
      }
      if (!r) {
        mergedHighlights.push(l);
        continue;
      }

      const createdAt = Math.max(l.createdAt ?? 0, r.createdAt ?? 0);
      const lDel = l.deletedAt ?? -1;
      const rDel = r.deletedAt ?? -1;
      const maxDel = Math.max(lDel, rDel);

      if (maxDel >= 0 && maxDel >= createdAt) {
        mergedHighlights.push({
          cfi,
          text: "",
          createdAt,
          deletedAt: maxDel,
        });
      } else {
        const primary = (l.createdAt ?? 0) > (r.createdAt ?? 0) ? l : r;
        const fallback = primary === l ? r : l;
        const text = primary.text || fallback.text;
        const chapter = primary.chapter ?? fallback.chapter;
        const percentage = primary.percentage ?? fallback.percentage;
        mergedHighlights.push({
          cfi,
          text,
          ...(chapter !== undefined ? { chapter } : {}),
          ...(percentage !== undefined ? { percentage } : {}),
          createdAt,
        });
      }
    }

    mergedBooks[id] = {
      ...(name ? { name } : {}),
      ...(progress ? { progress } : {}),
      highlights: mergedHighlights,
    };
  }

  return {
    version: 1,
    settings,
    books: mergedBooks,
  };
};

const downloadCloudData = async (
  dbx: Dropbox,
): Promise<{ data: CloudData | null; rev: string | null }> => {
  try {
    const res = await dbx.filesDownload({ path: DROPBOX_DATA_PATH });
    const result = res.result as any;
    const blob = readDownloadedBlob(result);
    const text = await blob.text();
    const parsed = JSON.parse(text) as CloudData;
    return { data: parsed, rev: result.rev ?? null };
  } catch (err) {
    if (isDropboxNotFoundError(err)) {
      return { data: null, rev: null };
    }
    return handleAuthFailureIfAny(err);
  }
};

const applyMergedStateLocally = async (
  merged: CloudData,
  localState: Awaited<ReturnType<typeof buildLocalCloudData>>,
) => {
  const newMeta: LocalSyncMeta = {
    progressUpdatedAt: { ...DEFAULT_META.progressUpdatedAt },
    deletedHighlights: {},
    fontSizeUpdatedAt: merged.settings.fontSize?.updatedAt ?? 0,
    themeUpdatedAt: merged.settings.theme?.updatedAt ?? 0,
  };

  if (
    merged.settings.fontSize &&
    merged.settings.fontSize.value !== localState.localFontSize
  ) {
    await localforage.setItem("reader-font-size", merged.settings.fontSize.value);
  }

  if (
    merged.settings.theme &&
    merged.settings.theme.value !== localState.localTheme
  ) {
    await localforage.setItem("reader-theme", merged.settings.theme.value);
  }

  for (const [bookId, bookState] of Object.entries(merged.books)) {
    if (bookState.progress) {
      newMeta.progressUpdatedAt[bookId] = bookState.progress.updatedAt;
      if (bookState.progress.cfi !== localState.localProgress[bookId]) {
        await localforage.setItem(`progress-${bookId}`, bookState.progress.cfi);
      }
    }

    const activeHighlights: StoredHighlightItem[] = [];
    const deletedMap: Record<string, number> = {};

    for (const h of bookState.highlights) {
      if (h.deletedAt !== undefined && h.deletedAt >= h.createdAt) {
        deletedMap[h.cfi] = h.deletedAt;
      } else {
        activeHighlights.push({
          cfi: h.cfi,
          text: h.text,
          ...(h.chapter !== undefined ? { chapter: h.chapter } : {}),
          ...(h.percentage !== undefined ? { percentage: h.percentage } : {}),
          createdAt: h.createdAt,
        });
      }
    }

    if (Object.keys(deletedMap).length > 0) {
      newMeta.deletedHighlights[bookId] = deletedMap;
    }

    const existingList = localState.localHighlights[bookId] ?? [];
    if (!canonicalEqual(activeHighlights, existingList)) {
      if (activeHighlights.length > 0 || localState.localHighlights[bookId]) {
        await localforage.setItem(`highlights-${bookId}`, activeHighlights);
      }
    }
  }

  await localforage.setItem(SYNC_META_KEY, newMeta);
};

const syncMetadataFile = async (dbx: Dropbox): Promise<{
  mergedData: CloudData;
  localBooks: Record<string, Book>;
  metadataChanged: boolean;
}> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const localState = await buildLocalCloudData();
    const { data: remoteData, rev: remoteRev } = await downloadCloudData(dbx);
    const mergedData = mergeCloudData(localState.localData, remoteData);

    await applyMergedStateLocally(mergedData, localState);

    const cloudNeedsUpdate =
      !remoteData || !canonicalEqual(mergedData, remoteData);

    if (!cloudNeedsUpdate) {
      return {
        mergedData,
        localBooks: localState.localBooks,
        metadataChanged: !canonicalEqual(localState.localData, mergedData),
      };
    }

    const blob = new Blob([JSON.stringify(mergedData)], {
      type: "application/json",
    });

    try {
      await dbx.filesUpload({
        path: DROPBOX_DATA_PATH,
        contents: blob,
        mode: remoteRev
          ? { ".tag": "update", update: remoteRev }
          : { ".tag": "add" },
      });

      return {
        mergedData,
        localBooks: localState.localBooks,
        metadataChanged: true,
      };
    } catch (err) {
      if (isDropboxConflictError(err) && attempt === 0) {
        // Retry once if another device updated data.json at the exact same moment
        continue;
      }
      return handleAuthFailureIfAny(err);
    }
  }

  throw new Error("Could not resolve metadata sync conflict.");
};

const listRemoteBooks = async (
  dbx: Dropbox,
): Promise<files.FileMetadataReference[]> => {
  const entries: files.FileMetadataReference[] = [];

  try {
    let res = await dbx.filesListFolder({ path: DROPBOX_BOOKS_DIR });
    for (const entry of res.result.entries) {
      if (entry[".tag"] === "file" && entry.name.toLowerCase().endsWith(".epub")) {
        entries.push(entry);
      }
    }

    while (res.result.has_more) {
      res = await dbx.filesListFolderContinue({ cursor: res.result.cursor });
      for (const entry of res.result.entries) {
        if (entry[".tag"] === "file" && entry.name.toLowerCase().endsWith(".epub")) {
          entries.push(entry);
        }
      }
    }
  } catch (err) {
    if (isDropboxNotFoundError(err)) {
      return [];
    }
    return handleAuthFailureIfAny(err);
  }

  return entries;
};

const uploadBookBinary = async (
  dbx: Dropbox,
  path: string,
  buffer: ArrayBuffer,
) => {
  const blob = new Blob([buffer], { type: "application/epub+zip" });

  try {
    if (blob.size <= SINGLE_UPLOAD_LIMIT) {
      await dbx.filesUpload({
        path,
        contents: blob,
        mode: { ".tag": "add" },
        autorename: false,
      });
      return;
    }

    // Chunked upload session for EPUBs larger than 140 MB
    let offset = 0;
    const firstChunk = blob.slice(0, CHUNK_SIZE);
    const startRes = await dbx.filesUploadSessionStart({
      close: false,
      contents: firstChunk,
    });
    const sessionId = startRes.result.session_id;
    offset += firstChunk.size;

    while (offset + CHUNK_SIZE < blob.size) {
      const chunk = blob.slice(offset, offset + CHUNK_SIZE);
      await dbx.filesUploadSessionAppendV2({
        cursor: { session_id: sessionId, offset },
        close: false,
        contents: chunk,
      });
      offset += chunk.size;
    }

    const lastChunk = blob.slice(offset);
    await dbx.filesUploadSessionFinish({
      cursor: { session_id: sessionId, offset },
      commit: {
        path,
        mode: { ".tag": "add" },
        autorename: false,
      },
      contents: lastChunk,
    });
  } catch (err) {
    if (isDropboxConflictError(err)) {
      // Already uploaded by another device
      return;
    }
    return handleAuthFailureIfAny(err);
  }
};

const extractBookDetails = async (
  arrayBuffer: ArrayBuffer,
  fallbackName: string,
): Promise<{ cover: string; title: string }> => {
  const epubBook = ePub(arrayBuffer);
  let cover = "";
  let title = fallbackName;

  try {
    const coverUrl = await epubBook.coverUrl();
    if (coverUrl) {
      const response = await fetch(coverUrl);
      const blob = await response.blob();
      cover = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string) || "");
        reader.readAsDataURL(blob);
      });
      URL.revokeObjectURL(coverUrl);
    }

    const metadata = await epubBook.loaded.metadata.catch(() => null);
    if (metadata?.title) {
      title = metadata.title;
    }
  } catch (err) {
    console.warn("Could not extract EPUB cover/metadata:", err);
  } finally {
    epubBook.destroy();
  }

  return { cover, title };
};

export const syncWithDropbox = async (): Promise<SyncResult> => {
  const dbx = await getDropboxClient();

  // 1. Merge tiny data.json first (highlights, reading positions, settings)
  const { mergedData, localBooks, metadataChanged } = await syncMetadataFile(dbx);

  // 2. Compare /lytreader/books/ against local books
  const remoteBookEntries = await listRemoteBooks(dbx);
  const remoteByBookId = new Map<string, files.FileMetadataReference>();

  for (const entry of remoteBookEntries) {
    const bookId = entry.name.slice(0, -5); // strip ".epub"
    remoteByBookId.set(bookId, entry);
  }

  // Upload any local books missing from Dropbox
  let uploadedBooksCount = 0;
  for (const [bookId, book] of Object.entries(localBooks)) {
    if (!remoteByBookId.has(bookId)) {
      await uploadBookBinary(
        dbx,
        `${DROPBOX_BOOKS_DIR}/${bookId}.epub`,
        book.data,
      );
      uploadedBooksCount++;
    }
  }

  // Download any Dropbox books missing locally
  const downloadedBooks: Book[] = [];
  for (const [bookId, entry] of remoteByBookId.entries()) {
    if (!localBooks[bookId]) {
      try {
        const res = await dbx.filesDownload({
          path: entry.path_lower || `${DROPBOX_BOOKS_DIR}/${entry.name}`,
        });
        const blob = readDownloadedBlob(res.result as any);
        const arrayBuffer = await blob.arrayBuffer();
        const cloudName = mergedData.books[bookId]?.name || entry.name;
        const { cover, title } = await extractBookDetails(arrayBuffer, cloudName);

        const newBookObj: Book = {
          id: bookId,
          name: mergedData.books[bookId]?.name || title,
          cover,
          data: arrayBuffer,
        };

        await localforage.setItem(bookId, newBookObj);
        downloadedBooks.push(newBookObj);
      } catch (err) {
        handleAuthFailureIfAny(err);
      }
    }
  }

  return {
    uploadedBooksCount,
    downloadedBooks,
    metadataChanged,
  };
};