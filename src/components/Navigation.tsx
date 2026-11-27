import { useRef, useState, useEffect } from "react";
import localforage from "localforage";
import ePub from "epubjs";
import { bufferToBase64, base64ToBuffer } from "../utils/backup";
import { startDropboxAuth, disconnectDropbox } from "../utils/dropbox";
import {
  touchBookAddedMeta,
  getBookSortTimestamps,
  sortBooksList,
} from "../utils/sync";
import type { Book, ShelfTheme } from "../App";

interface NavigationProps {
  setBooks: React.Dispatch<React.SetStateAction<Book[]>>;
  pinnedIds: Set<string>;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  shelfTheme: ShelfTheme;
  onToggleShelfTheme: () => void;
  isLoggedInDropbox: boolean;
  setIsLoggedInDropbox: React.Dispatch<React.SetStateAction<boolean>>;
  isSyncing: boolean;
  onSyncDropbox: () => void;
}

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

function Navigation({
  setBooks,
  pinnedIds,
  searchQuery,
  onSearchChange,
  shelfTheme,
  onToggleShelfTheme,
  isLoggedInDropbox,
  setIsLoggedInDropbox,
  isSyncing,
  onSyncDropbox,
}: NavigationProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [showSidebar, setShowSidebar] = useState(false);
  const [showSearchBar, setShowSearchBar] = useState(false);

  const isLight = shelfTheme === "light";

  useEffect(() => {
    if (showSearchBar) {
      searchInputRef.current?.focus();
    }
  }, [showSearchBar]);

  useEffect(() => {
    if (!showSidebar) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowSidebar(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showSidebar]);

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
      setBooks((prev: Book[]) =>
        sortBooksList([...prev, ...newBooks], timestamps, pinnedIds),
      );
      setShowSidebar(false);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
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
      } catch {
        alert("Restore failed");
      }
    };
    reader.readAsText(file);
  };

  const handleDisconnectDropbox = async () => {
    if (!confirm("Disconnect Dropbox from this device?")) return;
    await disconnectDropbox();
    setIsLoggedInDropbox(false);
  };

  const handleToggleSearch = () => {
    if (showSearchBar) {
      onSearchChange("");
      setShowSearchBar(false);
    } else {
      setShowSearchBar(true);
    }
  };

  return (
    <>
      {/* HIDDEN FILE INPUTS (kept outside sidebar so onChange always fires) */}
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
        ref={restoreInputRef}
        style={{ display: "none" }}
        onChange={handleLocalRestore}
        accept=".json"
      />

      {/* TOP NAVIGATION BAR */}
      <header className="px-3 pt-3 pb-1 sm:px-5 sm:pt-4">
        <nav
          className={`h-14 px-3 sm:px-4 rounded-2xl border backdrop-blur-md flex items-center justify-between gap-3 shadow-sm transition-colors duration-200 ${
            isLight
              ? "bg-[#fffdf8]/90 border-stone-900/[0.08] text-stone-800"
              : "bg-[#18181c]/90 border-white/[0.08] text-zinc-100"
          }`}
        >
          {/* Left: Menu Button & Library Label */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              aria-label="Open menu"
              onClick={() => setShowSidebar(true)}
              className={`p-2 rounded-xl transition-colors cursor-pointer ${
                isLight
                  ? "hover:bg-stone-900/[0.07] text-stone-700"
                  : "hover:bg-white/[0.08] text-zinc-200"
              }`}
            >
              <svg
                className="w-5 h-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            </button>

            {!showSearchBar && (
              <span className="text-sm font-semibold tracking-tight select-none">
                Library
              </span>
            )}
          </div>

          {/* Right: Real-time Shelf Search */}
          <div className="flex items-center justify-end gap-2 flex-1 max-w-md">
            {(showSearchBar || searchQuery) && (
              <div className="relative flex-1">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => onSearchChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      onSearchChange("");
                      setShowSearchBar(false);
                    }
                  }}
                  placeholder="Search books..."
                  className={`w-full rounded-xl pl-3.5 pr-8 py-1.5 text-sm border focus:outline-none transition-colors ${
                    isLight
                      ? "bg-stone-900/[0.04] border-stone-900/10 text-stone-800 placeholder-stone-400 focus:border-blue-600/50 focus:bg-white"
                      : "bg-white/[0.06] border-white/10 text-zinc-100 placeholder-zinc-500 focus:border-blue-400/50 focus:bg-white/[0.09]"
                  }`}
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      onSearchChange("");
                      searchInputRef.current?.focus();
                    }}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md transition-colors cursor-pointer ${
                      isLight
                        ? "text-stone-400 hover:text-stone-700"
                        : "text-zinc-400 hover:text-zinc-100"
                    }`}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              aria-label={showSearchBar ? "Close search" : "Search books"}
              onClick={handleToggleSearch}
              className={`p-2 rounded-xl transition-colors cursor-pointer shrink-0 ${
                showSearchBar || searchQuery
                  ? isLight
                    ? "bg-blue-600/12 text-blue-700 hover:bg-blue-600/20"
                    : "bg-blue-500/18 text-blue-300 hover:bg-blue-500/28"
                  : isLight
                    ? "hover:bg-stone-900/[0.07] text-stone-700"
                    : "hover:bg-white/[0.08] text-zinc-200"
              }`}
            >
              <svg
                className="w-5 h-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
          </div>
        </nav>
      </header>

      {/* FLOATING MINIMALIST SIDEBAR (50% width, rounded corners, inset from all edges) */}
      {showSidebar && (
        <div
          onClick={() => setShowSidebar(false)}
          className="fixed inset-0 z-40 bg-black/45 backdrop-blur-sm p-3 sm:p-5 flex items-stretch justify-start"
        >
          <aside
            onClick={(e) => e.stopPropagation()}
            className={`w-[80%] min-w-[235px] h-full rounded-2xl border shadow-2xl flex flex-col overflow-hidden transition-colors duration-200 ${
              isLight
                ? "bg-[#fdfaf3]/95 border-stone-900/10 text-stone-800"
                : "bg-[#18181c]/95 border-white/10 text-zinc-100"
            }`}
          >
            {/* Sidebar Header */}
            <div
              className={`px-4 py-3.5 border-b flex items-center justify-between ${
                isLight ? "border-stone-900/[0.08]" : "border-white/[0.08]"
              }`}
            >
              <span className="text-sm font-semibold tracking-tight">
                Menu
              </span>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setShowSidebar(false)}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                  isLight
                    ? "text-stone-500 hover:bg-stone-900/[0.07] hover:text-stone-800"
                    : "text-zinc-400 hover:bg-white/[0.08] hover:text-white"
                }`}
              >
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Sidebar Body */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-5">
              {/* Library Section */}
              <div className="space-y-2">
                <p
                  className={`px-1 text-[10px] font-semibold uppercase tracking-widest ${
                    isLight ? "text-stone-400" : "text-zinc-500"
                  }`}
                >
                  Library
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-sm font-medium flex items-center gap-2.5 transition-colors cursor-pointer ${
                    isLight
                      ? "bg-stone-900/[0.04] hover:bg-stone-900/[0.08] border-stone-900/[0.08] text-stone-800"
                      : "bg-white/[0.05] hover:bg-white/[0.1] border-white/[0.08] text-zinc-100"
                  }`}
                >
                  <svg
                    className="w-4 h-4 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                    <line x1="12" y1="7" x2="12" y2="13" />
                    <line x1="9" y1="10" x2="15" y2="10" />
                  </svg>
                  <span className="truncate">Import Books</span>
                </button>
              </div>

              {/* Appearance Section */}
              <div className="space-y-2">
                <p
                  className={`px-1 text-[10px] font-semibold uppercase tracking-widest ${
                    isLight ? "text-stone-400" : "text-zinc-500"
                  }`}
                >
                  Appearance
                </p>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isLight}
                  onClick={onToggleShelfTheme}
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-sm font-medium flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                    isLight
                      ? "bg-stone-900/[0.04] hover:bg-stone-900/[0.08] border-stone-900/[0.08] text-stone-800"
                      : "bg-white/[0.05] hover:bg-white/[0.1] border-white/[0.08] text-zinc-100"
                  }`}
                >
                  <span className="flex items-center gap-2.5 truncate">
                    {isLight ? (
                      <svg
                        className="w-4 h-4 shrink-0 text-amber-600"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="4" />
                        <path d="M12 2v2" />
                        <path d="M12 20v2" />
                        <path d="m4.93 4.93 1.41 1.41" />
                        <path d="m17.66 17.66 1.41 1.41" />
                        <path d="M2 12h2" />
                        <path d="M20 12h2" />
                        <path d="m6.34 17.66-1.41 1.41" />
                        <path d="m19.07 4.93-1.41 1.41" />
                      </svg>
                    ) : (
                      <svg
                        className="w-4 h-4 shrink-0 text-indigo-300"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                      </svg>
                    )}
                    <span className="truncate">Light Mode</span>
                  </span>

                  <span
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      isLight
                        ? "bg-blue-600"
                        : "bg-white/20"
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        isLight ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>
              </div>

              {/* Cloud Sync Section */}
              <div className="space-y-2">
                <p
                  className={`px-1 text-[10px] font-semibold uppercase tracking-widest ${
                    isLight ? "text-stone-400" : "text-zinc-500"
                  }`}
                >
                  Dropbox Sync
                </p>

                {!isLoggedInDropbox ? (
                  <button
                    type="button"
                    onClick={startDropboxAuth}
                    className={`w-full px-3.5 py-2.5 rounded-xl border text-sm font-medium flex items-center gap-2.5 transition-colors cursor-pointer ${
                      isLight
                        ? "bg-blue-600/10 hover:bg-blue-600/18 border-blue-600/20 text-blue-700"
                        : "bg-blue-500/15 hover:bg-blue-500/25 border-blue-400/25 text-blue-300"
                    }`}
                  >
                    <svg
                      className="w-4 h-4 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    <span className="truncate">Connect Dropbox</span>
                  </button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      disabled={isSyncing}
                      onClick={() => {
                        setShowSidebar(false);
                        onSyncDropbox();
                      }}
                      className={`w-full px-3.5 py-2.5 rounded-xl border text-sm font-medium flex items-center gap-2.5 transition-colors cursor-pointer disabled:opacity-60 ${
                        isLight
                          ? "bg-blue-600/10 hover:bg-blue-600/18 border-blue-600/20 text-blue-700"
                          : "bg-blue-500/15 hover:bg-blue-500/25 border-blue-400/25 text-blue-300"
                      }`}
                    >
                      <svg
                        className={`w-4 h-4 shrink-0 ${isSyncing ? "animate-spin" : ""}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                        <path d="M16 16h5v5" />
                      </svg>
                      <span className="truncate">
                        {isSyncing ? "Syncing..." : "Sync Now"}
                      </span>
                    </button>

                    <button
                      type="button"
                      disabled={isSyncing}
                      onClick={handleDisconnectDropbox}
                      className={`w-full px-3.5 py-2 rounded-xl border text-xs font-medium flex items-center gap-2.5 transition-colors cursor-pointer disabled:opacity-50 ${
                        isLight
                          ? "bg-stone-900/[0.04] hover:bg-stone-900/[0.08] border-stone-900/[0.08] text-stone-600"
                          : "bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.08] text-zinc-400"
                      }`}
                    >
                      <span className="truncate">Disconnect Dropbox</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Local Backup Section */}
              <div className="space-y-2">
                <p
                  className={`px-1 text-[10px] font-semibold uppercase tracking-widest ${
                    isLight ? "text-stone-400" : "text-zinc-500"
                  }`}
                >
                  Local Backup
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={handleLocalExport}
                    className={`w-full px-3.5 py-2.5 rounded-xl border text-sm font-medium flex items-center gap-2.5 transition-colors cursor-pointer ${
                      isLight
                        ? "bg-blue-600/10 hover:bg-blue-600/18 border-blue-600/20 text-blue-700"
                        : "bg-blue-500/15 hover:bg-blue-500/25 border-blue-400/25 text-blue-300"
                    }`}
                  >
                    <svg
                      className="w-4 h-4 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <span className="truncate">Export Backup</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => restoreInputRef.current?.click()}
                    className={`w-full px-3.5 py-2.5 rounded-xl border text-sm font-medium flex items-center gap-2.5 transition-colors cursor-pointer ${
                      isLight
                        ? "bg-rose-600/10 hover:bg-rose-600/18 border-rose-600/20 text-rose-700"
                        : "bg-rose-500/15 hover:bg-rose-500/25 border-rose-400/25 text-rose-300"
                    }`}
                  >
                    <svg
                      className="w-4 h-4 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    <span className="truncate">Restore Backup</span>
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

export default Navigation;