import { useRef, useState, useEffect } from "react";
import localforage from "localforage";
import ePub from "epubjs";
import { bufferToBase64, base64ToBuffer } from "../utils/backup";
import {
  initDropboxAuth,
  startDropboxAuth,
  disconnectDropbox,
  DropboxAuthError,
} from "../utils/dropbox";
import {
  syncWithDropbox,
  touchBookAddedMeta,
  getBookSortTimestamps,
  sortBooksList,
} from "../utils/sync";
import type { Book } from "../App";

const computeBookId = async (
  file: File,
  arrayBuffer: ArrayBuffer,
): Promise<string> => {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `book-${hex.slice(0, 24)}`;
  }
  const safeName = file.name.replace(/[\\/:*?"<>|]/g, "_");
  return `book-${safeName}-${file.size}`;
};

function Navigation({ setBooks }: { setBooks: Function }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const [isSyncing, setIsSyncing] = useState(false);
  const [isLoggedInDropbox, setIsLoggedInDropbox] = useState(false);

  useEffect(() => {
    let active = true;
    initDropboxAuth().then((connected) => {
      if (active) setIsLoggedInDropbox(connected);
    });
    return () => {
      active = false;
    };
  }, []);

  const gatherAllData = async () => {
    const keys = await localforage.keys();
    const fullData: Record<string, any> = {};
    for (const key of keys) {
      const value = await localforage.getItem(key);
      if (key.startsWith("book-") && value && typeof value === "object") {
        const bookValue = value as any;
        fullData[key] = { ...bookValue, data: bufferToBase64(bookValue.data) };
      } else {
        fullData[key] = value;
      }
    }
    return fullData;
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = event.target.files;
    if (!files) return;

    const existingKeys = await localforage.keys();
    const existingBooks = (
      await Promise.all(
        existingKeys
          .filter((k) => k.startsWith("book-"))
          .map((k) => localforage.getItem<Book>(k)),
      )
    ).filter(Boolean) as Book[];

    const newBooks: Book[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.name.toLowerCase().endsWith(".epub")) continue;
      try {
        const arrayBuffer = await file.arrayBuffer();
        const bookId = await computeBookId(file, arrayBuffer);

        const alreadyExists =
          existingBooks.some(
            (b) =>
              b.id === bookId ||
              (b.name === file.name &&
                b.data?.byteLength === arrayBuffer.byteLength),
          ) || newBooks.some((b) => b.id === bookId);

        if (alreadyExists) continue;

        const book = ePub(arrayBuffer);
        let permanentCover = "";
        try {
          const coverUrl = await book.coverUrl();
          if (coverUrl) {
            const response = await fetch(coverUrl);
            const blob = await response.blob();
            permanentCover = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result as string);
              reader.readAsDataURL(blob);
            });
            URL.revokeObjectURL(coverUrl);
          }
        } finally {
          book.destroy();
        }

        const newBookObj: Book = {
          id: bookId,
          name: file.name,
          cover: permanentCover || "",
          data: arrayBuffer,
        };
        await localforage.setItem(bookId, newBookObj);
        await touchBookAddedMeta(bookId);
        newBooks.push(newBookObj);
      } catch (error) {
        console.error(error);
      }
    }
    if (newBooks.length > 0) {
      const timestamps = await getBookSortTimestamps();
      setBooks((prev: Book[]) => sortBooksList([...prev, ...newBooks], timestamps));
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  };

  const handleLocalExport = async () => {
    const data = await gatherAllData();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `reader-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleLocalRestore = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        await localforage.clear();
        for (const [key, value] of Object.entries(json)) {
          let dataToSave = value;
          if (key.startsWith("book-") && value && typeof value === "object") {
            const bookValue = value as any;
            dataToSave = { ...bookValue, data: base64ToBuffer(bookValue.data) };
          }
          await localforage.setItem(key, dataToSave);
        }
        window.location.reload();
      } catch (err) {
        alert("Restore failed");
      }
    };
    reader.readAsText(file);
  };

  const handleSyncDropbox = async () => {
    setIsSyncing(true);
    try {
      const result = await syncWithDropbox();

      if (
        result.downloadedBooks.length > 0 ||
        result.deletedBookIds.length > 0 ||
        result.metadataChanged
      ) {
        const timestamps = await getBookSortTimestamps();
        const deletedSet = new Set(result.deletedBookIds);
        setBooks((prev: Book[]) => {
          const remaining = prev.filter((b) => !deletedSet.has(b.id));
          const existingIds = new Set(remaining.map((b) => b.id));
          const additions = result.downloadedBooks.filter(
            (b) => !existingIds.has(b.id),
          );
          return sortBooksList([...remaining, ...additions], timestamps);
        });
      }

      const parts: string[] = [];
      if (result.uploadedBooksCount > 0) {
        parts.push(`↑ ${result.uploadedBooksCount} book(s) uploaded`);
      }
      if (result.downloadedBooks.length > 0) {
        parts.push(`↓ ${result.downloadedBooks.length} book(s) downloaded`);
      }
      if (result.deletedFromCloudCount > 0) {
        parts.push(`${result.deletedFromCloudCount} book(s) deleted from cloud`);
      }
      if (result.deletedBookIds.length > 0) {
        parts.push(`${result.deletedBookIds.length} book(s) removed locally`);
      }
      if (result.metadataChanged) {
        parts.push("progress & highlights synced");
      }

      alert(parts.length > 0 ? `Synced! (${parts.join(", ")})` : "Already up to date!");
    } catch (error) {
      if (error instanceof DropboxAuthError) {
        setIsLoggedInDropbox(false);
        alert(error.message);
      } else {
        console.error("Dropbox sync error:", error);
        alert("Sync failed. Please check your connection and try again.");
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const handleDisconnectDropbox = async () => {
    if (!confirm("Disconnect Dropbox from this device?")) return;
    await disconnectDropbox();
    setIsLoggedInDropbox(false);
  };

  return (
    <nav className="ma2 br3 ba bw1 navBorderColor bg-[#1c1c1c] flex flex-wrap lg:flex-nowrap items-center justify-center lg:justify-between p-2 md:ph4 md:pv2 gap-4 shadow-lg">
      {/* HIDDEN INPUTS */}
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: "none" }}
        onChange={handleFileChange}
        multiple
        accept=".epub"
      />
      <input
        type="file"
        ref={folderInputRef}
        style={{ display: "none" }}
        onChange={handleFileChange}
        {...({ webkitdirectory: "", directory: "" } as any)}
        multiple
      />
      <input
        type="file"
        ref={restoreInputRef}
        style={{ display: "none" }}
        onChange={handleLocalRestore}
        accept=".json"
      />

      {/* LEFT GROUP: Library Management */}
      <div className="flex items-center justify-center gap-2 w-full sm:w-auto">
        <button
          className="flex-1 sm:flex-none text-gray-200 bg-white/5 hover:bg-white/10 bn pointer pv2 ph3 br2 transition-all flex items-center justify-center gap-2 text-sm font-medium whitespace-nowrap"
          onClick={() => fileInputRef.current?.click()}
        >
          <span>📖</span> <span className="dn di-m di-l">Import</span> Books
        </button>
        <button
          className="flex-1 sm:flex-none text-gray-200 bg-white/5 hover:bg-white/10 bn pointer pv2 ph3 br2 transition-all flex items-center justify-center gap-2 text-sm font-medium whitespace-nowrap"
          onClick={() => folderInputRef.current?.click()}
        >
          <span>📁</span> <span className="dn di-m di-l">Import</span> Folder
        </button>
      </div>

      {/* RIGHT GROUP: Sync & Backup */}
      <div className="flex flex-wrap items-center justify-center gap-3 w-full lg:w-auto">
        {/* Dropbox Interface */}
        <div className="flex items-center justify-center gap-2 w-full sm:w-auto">
          {!isLoggedInDropbox ? (
            <button
              className="flex-1 sm:flex-none bg-indigo-700 hover:bg-indigo-600 white bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight whitespace-nowrap"
              onClick={startDropboxAuth}
            >
              🔗 Connect Dropbox
            </button>
          ) : (
            <div className="flex items-center justify-center gap-2 w-full sm:w-auto">
              <button
                disabled={isSyncing}
                className="flex-1 sm:flex-none bg-indigo-700 hover:bg-indigo-600 white bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight min-w-[120px] whitespace-nowrap"
                onClick={handleSyncDropbox}
              >
                {isSyncing ? "⏳ Syncing..." : "☁️ Sync"}
              </button>
              <button
                disabled={isSyncing}
                className="bg-white/10 hover:bg-white/20 text-gray-300 bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight whitespace-nowrap"
                onClick={handleDisconnectDropbox}
              >
                Disconnect
              </button>
            </div>
          )}
        </div>

        {/* Vertical Divider (Visible ONLY on large desktop screens so it stays out of the way on tablet wraps) */}
        <div className="hidden lg:block bl bw1 h1 mh1 border-white-10 navBorderColor"></div>

        {/* Local Interface */}
        <div className="flex items-center justify-center gap-2 w-full sm:w-auto border-t border-white/5 pt-3 sm:pt-0 sm:border-t-0">
          <button
            className="flex-1 sm:flex-none bg-blue-700 hover:bg-blue-600 white bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight whitespace-nowrap"
            onClick={handleLocalExport}
          >
            📤 Export
          </button>
          <button
            className="flex-1 sm:flex-none bg-red-800 hover:bg-red-700 white bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight whitespace-nowrap"
            onClick={() => restoreInputRef.current?.click()}
          >
            📥 Restore
          </button>
        </div>
      </div>
    </nav>
  );
}

export default Navigation;