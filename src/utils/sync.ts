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

export interface BookDailyStat {
  date: string; // YYYY-MM-DD (local date)
  percentage: number;
  wpm: number;
  words: number;
  seconds: number;
  updatedAt: number;
}

export interface SyncHighlight {
  cfi: string;
  text: string;
  chapter?: string;
  percentage?: number;
  createdAt: number;
  deletedAt?: number;
}

export interface SyncPinState {
  value: boolean;
  updatedAt: number;
}

export interface SyncBookState {
  name?: string;
  addedAt?: number;
  lastOpenedAt?: number;
  pinned?: SyncPinState;
  progress?: {
    cfi: string;
    updatedAt: number;
  };
  highlights: SyncHighlight[];
  dailyStats?: BookDailyStat[];
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
  deletedBooks?: Record<string, number>;
}

interface LocalSyncMeta {
  bookAddedAt: Record<string, number>;
  bookLastOpenedAt: Record<string, number>;
  pinnedBooks: Record<string, { pinned: boolean; updatedAt: number }>;
  deletedBooks: Record<string, number>;
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
  deletedFromCloudCount: number;
  deletedBookIds: string[];
  metadataChanged: boolean;
}

// Serialize local sync-meta and reading-stats updates so rapid scrolled `relocated` events never race
let metaWriteQueue: Promise<void> = Promise.resolve();
let statsWriteQueue: Promise<void> = Promise.resolve();

const getLocalDateKey = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getSyncMeta = async (): Promise<LocalSyncMeta> => {
  const saved = await localforage.getItem<Partial<LocalSyncMeta>>(SYNC_META_KEY);
  return {
    bookAddedAt: { ...(saved?.bookAddedAt ?? {}) },
    bookLastOpenedAt: { ...(saved?.bookLastOpenedAt ?? {}) },
    pinnedBooks: { ...(saved?.pinnedBooks ?? {}) },
    deletedBooks: { ...(saved?.deletedBooks ?? {}) },
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

export const touchBookAddedMeta = (bookId: string): Promise<void> => {
  const now = Date.now();
  return updateSyncMeta((meta) => {
    meta.bookAddedAt[bookId] = now;
    delete meta.deletedBooks[bookId];
  });
};

export const touchBookLastOpenedMeta = (bookId: string): Promise<void> => {
  const now = Date.now();
  return updateSyncMeta((meta) => {
    meta.bookLastOpenedAt[bookId] = now;
  });
};

export const setBookPinnedMeta = (
  bookId: string,
  pinned: boolean,
): Promise<void> => {
  const now = Date.now();
  return updateSyncMeta((meta) => {
    meta.pinnedBooks[bookId] = { pinned, updatedAt: now };
  });
};

export const getPinnedBookIds = async (): Promise<Set<string>> => {
  await metaWriteQueue;
  const meta = await getSyncMeta();
  const pinned = new Set<string>();
  for (const [bookId, state] of Object.entries(meta.pinnedBooks)) {
    if (state?.pinned) {
      pinned.add(bookId);
    }
  }
  return pinned;
};

export const getBookSortTimestamps = async (): Promise<
  Record<string, number>
> => {
  await metaWriteQueue;
  const meta = await getSyncMeta();
  const timestamps: Record<string, number> = {};
  const ids = new Set([
    ...Object.keys(meta.bookAddedAt),
    ...Object.keys(meta.bookLastOpenedAt),
  ]);
  for (const id of ids) {
    timestamps[id] = meta.bookLastOpenedAt[id] || meta.bookAddedAt[id] || 0;
  }
  return timestamps;
};

export const sortBooksList = (
  books: Book[],
  timestamps: Record<string, number>,
  pinnedIds?: Set<string>,
): Book[] => {
  return [...books].sort((a, b) => {
    const aPinned = pinnedIds?.has(a.id) ? 1 : 0;
    const bPinned = pinnedIds?.has(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;

    const diff = (timestamps[b.id] ?? 0) - (timestamps[a.id] ?? 0);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });
};

export const recordBookReadingStat = (
  bookId: string,
  params: { percentage?: number; addedWords?: number; addedSeconds?: number },
): Promise<BookDailyStat[]> => {
  const resultPromise = statsWriteQueue.then(async () => {
    const today = getLocalDateKey();
    const existing =
      (await localforage.getItem<BookDailyStat[]>(`stats-${bookId}`)) ?? [];
    const list = Array.isArray(existing)
      ? existing.map((item) => ({ ...item }))
      : [];

    let entry = list.find((item) => item.date === today);
    const now = Date.now();
    if (!entry) {
      entry = {
        date: today,
        percentage: 0,
        wpm: 0,
        words: 0,
        seconds: 0,
        updatedAt: now,
      };
      list.push(entry);
    }

    let changed = false;

    if (
      typeof params.percentage === "number" &&
      Number.isFinite(params.percentage)
    ) {
      const clamped = Math.min(100, Math.max(0, Math.round(params.percentage)));
      if (clamped > entry.percentage) {
        entry.percentage = clamped;
        changed = true;
      }
    }

    if (
      typeof params.addedWords === "number" &&
      params.addedWords > 0 &&
      typeof params.addedSeconds === "number" &&
      params.addedSeconds > 0
    ) {
      entry.words += Math.round(params.addedWords);
      entry.seconds += params.addedSeconds;
      if (entry.seconds >= 5) {
        entry.wpm = Math.round((entry.words / entry.seconds) * 60);
      }
      changed = true;
    }

    if (changed) {
      entry.updatedAt = now;
      list.sort((a, b) => b.date.localeCompare(a.date));
      await localforage.setItem(`stats-${bookId}`, list);
    }

    return list;
  });

  statsWriteQueue = resultPromise.then(
    () => undefined,
    (err) => {
      console.error("Failed to record reading stat:", err);
    },
  );

  return resultPromise;
};

export const getBookDailyStats = async (
  bookId: string,
): Promise<BookDailyStat[]> => {
  await statsWriteQueue;
  const saved = await localforage.getItem<BookDailyStat[]>(`stats-${bookId}`);
  if (!Array.isArray(saved)) return [];
  return [...saved].sort((a, b) => b.date.localeCompare(a.date));
};

export const getAllBookDailyStats = async (): Promise<
  Record<string, BookDailyStat[]>
> => {
  await statsWriteQueue;
  const keys = await localforage.keys();
  const statKeys = keys.filter((k) => k.startsWith("stats-"));
  const result: Record<string, BookDailyStat[]> = {};

  await Promise.all(
    statKeys.map(async (key) => {
      const stats = await localforage.getItem<BookDailyStat[]>(key);
      if (Array.isArray(stats) && stats.length > 0) {
        const bookId = key.slice("stats-".length);
        result[bookId] = [...stats].sort((a, b) => b.date.localeCompare(a.date));
      }
    }),
  );

  return result;
};

export const deleteBookLocally = async (bookId: string): Promise<void> => {
  await statsWriteQueue;
  await Promise.all([
    localforage.removeItem(bookId),
    localforage.removeItem(`progress-${bookId}`),
    localforage.removeItem(`highlights-${bookId}`),
    localforage.removeItem(`locations-${bookId}`),
    localforage.removeItem(`stats-${bookId}`),
  ]);

  const now = Date.now();
  await updateSyncMeta((meta) => {
    meta.deletedBooks[bookId] = now;
    delete meta.bookAddedAt[bookId];
    delete meta.bookLastOpenedAt[bookId];
    delete meta.pinnedBooks[bookId];
    delete meta.progressUpdatedAt[bookId];
    delete meta.deletedHighlights[bookId];
  });
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
    (k) =>
      Object.prototype.hasOwnProperty.call(objB, k) &&
      canonicalEqual(objA[k], objB[k]),
  );
};

const normalizeStatsList = (list: BookDailyStat[]): BookDailyStat[] =>
  [...list]
    .map((s) => ({
      date: s.date,
      percentage: Math.min(100, Math.max(0, Math.round(s.percentage ?? 0))),
      wpm: Math.max(0, Math.round(s.wpm ?? 0)),
      words: Math.max(0, Math.round(s.words ?? 0)),
      seconds: Math.max(0, Number(s.seconds ?? 0)),
      updatedAt: s.updatedAt ?? 0,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

const buildLocalCloudData = async (): Promise<{
  localData: CloudData;
  localBooks: Record<string, Book>;
  localProgress: Record<string, string>;
  localHighlights: Record<string, StoredHighlightItem[]>;
  localStats: Record<string, BookDailyStat[]>;
  localFontSize: number | null;
  localTheme: "dark" | "light" | null;
  meta: LocalSyncMeta;
}> => {
  await metaWriteQueue;
  await statsWriteQueue;
  const meta = await getSyncMeta();
  const keys = await localforage.keys();

  const localBooks: Record<string, Book> = {};
  const localProgress: Record<string, string> = {};
  const localHighlights: Record<string, StoredHighlightItem[]> = {};
  const localStats: Record<string, BookDailyStat[]> = {};
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
      } else if (key.startsWith("stats-")) {
        const stats = await localforage.getItem<BookDailyStat[]>(key);
        if (Array.isArray(stats)) {
          localStats[key.slice("stats-".length)] = normalizeStatsList(stats);
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
    ...Object.keys(localStats),
    ...Object.keys(meta.pinnedBooks),
    ...Object.keys(meta.deletedHighlights),
    ...Object.keys(meta.deletedBooks),
  ]);

  const books: Record<string, SyncBookState> = {};
  const deletedBooks: Record<string, number> = {};

  for (const id of Array.from(bookIds).sort()) {
    const addedAt = meta.bookAddedAt[id] ?? 0;
    const lastOpenedAt = meta.bookLastOpenedAt[id] ?? 0;
    const deletedAt = meta.deletedBooks[id];

    if (deletedAt !== undefined && (!localBooks[id] || deletedAt >= addedAt)) {
      deletedBooks[id] = deletedAt;
      continue;
    }

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
    for (const [cfi, hlDeletedAt] of Object.entries(deletedMap)) {
      const existing = hlMap.get(cfi);
      if (!existing || hlDeletedAt >= existing.createdAt) {
        hlMap.set(cfi, {
          cfi,
          text: "",
          createdAt: existing?.createdAt ?? 0,
          deletedAt: hlDeletedAt,
        });
      }
    }

    const highlights = Array.from(hlMap.values()).sort((a, b) =>
      a.cfi.localeCompare(b.cfi),
    );

    const dailyStats = localStats[id] ?? [];
    const pinMeta = meta.pinnedBooks[id];
    const progressCfi = localProgress[id];
    const bookName = localBooks[id]?.name;

    books[id] = {
      ...(bookName ? { name: bookName } : {}),
      ...(addedAt > 0 ? { addedAt } : {}),
      ...(lastOpenedAt > 0 ? { lastOpenedAt } : {}),
      ...(pinMeta
        ? {
            pinned: {
              value: pinMeta.pinned,
              updatedAt: pinMeta.updatedAt,
            },
          }
        : {}),
      ...(progressCfi
        ? {
            progress: {
              cfi: progressCfi,
              updatedAt: meta.progressUpdatedAt[id] ?? 0,
            },
          }
        : {}),
      highlights,
      ...(dailyStats.length > 0 ? { dailyStats } : {}),
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
      ...(Object.keys(deletedBooks).length > 0 ? { deletedBooks } : {}),
    },
    localBooks,
    localProgress,
    localHighlights,
    localStats,
    localFontSize,
    localTheme,
    meta,
  };
};

const mergeDailyStats = (
  localStats: BookDailyStat[] = [],
  remoteStats: BookDailyStat[] = [],
): BookDailyStat[] => {
  const byDate = new Map<
    string,
    { l?: BookDailyStat; r?: BookDailyStat }
  >();

  for (const r of remoteStats) {
    byDate.set(r.date, { r });
  }
  for (const l of localStats) {
    const pair = byDate.get(l.date) ?? {};
    pair.l = l;
    byDate.set(l.date, pair);
  }

  const merged: BookDailyStat[] = [];
  for (const date of Array.from(byDate.keys()).sort((a, b) =>
    b.localeCompare(a),
  )) {
    const { l, r } = byDate.get(date)!;
    if (!l) {
      merged.push(r!);
      continue;
    }
    if (!r) {
      merged.push(l);
      continue;
    }

    const lTime = l.updatedAt ?? 0;
    const rTime = r.updatedAt ?? 0;
    let primary: BookDailyStat;
    if (lTime !== rTime) {
      primary = lTime > rTime ? l : r;
    } else if ((l.words ?? 0) !== (r.words ?? 0)) {
      primary = (l.words ?? 0) > (r.words ?? 0) ? l : r;
    } else {
      primary = (l.percentage ?? 0) >= (r.percentage ?? 0) ? l : r;
    }

    merged.push({
      date,
      percentage: Math.max(l.percentage ?? 0, r.percentage ?? 0),
      wpm: primary.wpm ?? 0,
      words: primary.words ?? 0,
      seconds: primary.seconds ?? 0,
      updatedAt: Math.max(lTime, rTime),
    });
  }

  return normalizeStatsList(merged);
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
    new Set([
      ...Object.keys(local.books),
      ...Object.keys(remote.books ?? {}),
      ...Object.keys(local.deletedBooks ?? {}),
      ...Object.keys(remote.deletedBooks ?? {}),
    ]),
  ).sort();

  const mergedBooks: Record<string, SyncBookState> = {};
  const mergedDeletedBooks: Record<string, number> = {};

  for (const id of allBookIds) {
    const lBook = local.books[id];
    const rBook = remote.books?.[id];
    const lBookDel = local.deletedBooks?.[id] ?? -1;
    const rBookDel = remote.deletedBooks?.[id] ?? -1;
    const maxBookDel = Math.max(lBookDel, rBookDel);
    const maxAddedAt = Math.max(lBook?.addedAt ?? 0, rBook?.addedAt ?? 0);
    const maxLastOpenedAt = Math.max(
      lBook?.lastOpenedAt ?? 0,
      rBook?.lastOpenedAt ?? 0,
    );

    if (maxBookDel >= 0 && maxBookDel >= maxAddedAt) {
      mergedDeletedBooks[id] = maxBookDel;
      continue;
    }

    const name = rBook?.name || lBook?.name;

    let pinned: SyncPinState | undefined;
    if (lBook?.pinned && rBook?.pinned) {
      pinned =
        lBook.pinned.updatedAt > rBook.pinned.updatedAt
          ? lBook.pinned
          : rBook.pinned;
    } else {
      pinned = rBook?.pinned || lBook?.pinned;
    }

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

    const mergedDailyStats = mergeDailyStats(
      lBook?.dailyStats,
      rBook?.dailyStats,
    );

    mergedBooks[id] = {
      ...(name ? { name } : {}),
      ...(maxAddedAt > 0 ? { addedAt: maxAddedAt } : {}),
      ...(maxLastOpenedAt > 0 ? { lastOpenedAt: maxLastOpenedAt } : {}),
      ...(pinned ? { pinned } : {}),
      ...(progress ? { progress } : {}),
      highlights: mergedHighlights,
      ...(mergedDailyStats.length > 0 ? { dailyStats: mergedDailyStats } : {}),
    };
  }

  return {
    version: 1,
    settings,
    books: mergedBooks,
    ...(Object.keys(mergedDeletedBooks).length > 0
      ? { deletedBooks: mergedDeletedBooks }
      : {}),
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
): Promise<string[]> => {
  const newMeta: LocalSyncMeta = {
    bookAddedAt: {},
    bookLastOpenedAt: {},
    pinnedBooks: {},
    deletedBooks: { ...(merged.deletedBooks ?? {}) },
    progressUpdatedAt: {},
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

  const deletedBookIds: string[] = [];
  for (const bookId of Object.keys(merged.deletedBooks ?? {})) {
    const hadBook = Boolean(localState.localBooks[bookId]);
    const hadProgress = Boolean(localState.localProgress[bookId]);
    const hadHighlights = Boolean(localState.localHighlights[bookId]);
    const hadStats = Boolean(localState.localStats[bookId]);

    if (hadBook || hadProgress || hadHighlights || hadStats) {
      await Promise.all([
        localforage.removeItem(bookId),
        localforage.removeItem(`progress-${bookId}`),
        localforage.removeItem(`highlights-${bookId}`),
        localforage.removeItem(`locations-${bookId}`),
        localforage.removeItem(`stats-${bookId}`),
      ]);
    }
    if (hadBook) {
      deletedBookIds.push(bookId);
    }
  }

  for (const [bookId, bookState] of Object.entries(merged.books)) {
    if (bookState.addedAt && bookState.addedAt > 0) {
      newMeta.bookAddedAt[bookId] = bookState.addedAt;
    }
    if (bookState.lastOpenedAt && bookState.lastOpenedAt > 0) {
      newMeta.bookLastOpenedAt[bookId] = bookState.lastOpenedAt;
    }
    if (bookState.pinned) {
      newMeta.pinnedBooks[bookId] = {
        pinned: bookState.pinned.value,
        updatedAt: bookState.pinned.updatedAt,
      };
    }

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

    const mergedStats = normalizeStatsList(bookState.dailyStats ?? []);
    const existingStats = localState.localStats[bookId] ?? [];
    if (!canonicalEqual(mergedStats, existingStats)) {
      if (mergedStats.length > 0 || localState.localStats[bookId]) {
        await localforage.setItem(`stats-${bookId}`, mergedStats);
      }
    }
  }

  await localforage.setItem(SYNC_META_KEY, newMeta);
  return deletedBookIds;
};

const syncMetadataFile = async (dbx: Dropbox): Promise<{
  mergedData: CloudData;
  localBooks: Record<string, Book>;
  deletedBookIds: string[];
  metadataChanged: boolean;
}> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const localState = await buildLocalCloudData();
    const { data: remoteData, rev: remoteRev } = await downloadCloudData(dbx);
    const mergedData = mergeCloudData(localState.localData, remoteData);

    const deletedBookIds = await applyMergedStateLocally(mergedData, localState);

    const cloudNeedsUpdate =
      !remoteData || !canonicalEqual(mergedData, remoteData);

    if (!cloudNeedsUpdate) {
      return {
        mergedData,
        localBooks: localState.localBooks,
        deletedBookIds,
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
        deletedBookIds,
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

const deleteRemoteBookBinary = async (
  dbx: Dropbox,
  path: string,
): Promise<boolean> => {
  try {
    await dbx.filesDeleteV2({ path });
    return true;
  } catch (err) {
    if (isDropboxNotFoundError(err)) {
      return false;
    }
    return handleAuthFailureIfAny(err);
  }
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

  // 1. Merge tiny data.json first (highlights, reading positions, order, pins, stats, settings, deletions)
  const { mergedData, localBooks, deletedBookIds, metadataChanged } =
    await syncMetadataFile(dbx);

  // 2. Compare /lytreader/books/ against local books
  const remoteBookEntries = await listRemoteBooks(dbx);
  const remoteByBookId = new Map<string, files.FileMetadataReference>();

  for (const entry of remoteBookEntries) {
    const bookId = entry.name.slice(0, -5); // strip ".epub"
    remoteByBookId.set(bookId, entry);
  }

  // 2a. Delete any books from Dropbox that were deleted on any device
  let deletedFromCloudCount = 0;
  for (const bookId of Object.keys(mergedData.deletedBooks ?? {})) {
    const entry = remoteByBookId.get(bookId);
    if (entry) {
      const removed = await deleteRemoteBookBinary(
        dbx,
        entry.path_lower || `${DROPBOX_BOOKS_DIR}/${entry.name}`,
      );
      if (removed) deletedFromCloudCount++;
      remoteByBookId.delete(bookId);
    }
  }

  // 2b. Upload any local books missing from Dropbox (skipping deleted ones)
  let uploadedBooksCount = 0;
  for (const [bookId, book] of Object.entries(localBooks)) {
    if (mergedData.deletedBooks?.[bookId]) continue;
    if (!remoteByBookId.has(bookId)) {
      await uploadBookBinary(
        dbx,
        `${DROPBOX_BOOKS_DIR}/${bookId}.epub`,
        book.data,
      );
      uploadedBooksCount++;
    }
  }

  // 2c. Download any Dropbox books missing locally
  const downloadedBooks: Book[] = [];
  for (const [bookId, entry] of remoteByBookId.entries()) {
    if (mergedData.deletedBooks?.[bookId]) continue;
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
    deletedFromCloudCount,
    deletedBookIds,
    metadataChanged,
  };
};