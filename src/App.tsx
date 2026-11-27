import { useState, useEffect, useCallback, useRef } from "react";
import "./App.css";
import Navigation from "./components/Navigation.tsx";
import Shelf from "./components/Shelf.tsx";
import Reader from "./components/Reader.tsx";
import localforage from "localforage";
import { initDropboxAuth, DropboxAuthError } from "./utils/dropbox";
import {
  syncWithDropbox,
  deleteBookLocally,
  touchBookLastOpenedMeta,
  setBookPinnedMeta,
  getPinnedBookIds,
  getBookSortTimestamps,
  sortBooksList,
  getAllBookDailyStats,
  type BookDailyStat,
} from "./utils/sync";

export type Book = {
  id: string;
  name: string;
  data: ArrayBuffer;
  cover: string;
};

export type ShelfTheme = "dark" | "light";

interface SyncToastState {
  status: "syncing" | "success" | "error";
  message: string;
}

const SHELF_THEME_KEY = "shelf-theme";

function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [bookStats, setBookStats] = useState<Record<string, BookDailyStat[]>>(
    {},
  );
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [shelfTheme, setShelfTheme] = useState<ShelfTheme>("dark");

  const [isLoggedInDropbox, setIsLoggedInDropbox] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncToast, setSyncToast] = useState<SyncToastState | null>(null);

  const syncInFlightRef = useRef<boolean>(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinnedIdsRef = useRef<Set<string>>(pinnedIds);

  useEffect(() => {
    pinnedIdsRef.current = pinnedIds;
  }, [pinnedIds]);

  const showToast = useCallback(
    (toast: SyncToastState, autoDismissMs?: number) => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      setSyncToast(toast);
      if (autoDismissMs) {
        toastTimerRef.current = setTimeout(() => {
          toastTimerRef.current = null;
          setSyncToast(null);
        }, autoDismissMs);
      }
    },
    [],
  );

  const loadLibraryMetadata = useCallback(async () => {
    const [timestamps, pinned, stats] = await Promise.all([
      getBookSortTimestamps(),
      getPinnedBookIds(),
      getAllBookDailyStats(),
    ]);
    setPinnedIds(pinned);
    setBookStats(stats);
    setBooks((prev) => sortBooksList(prev, timestamps, pinned));
    return { timestamps, pinned, stats };
  }, []);

  const runSync = useCallback(async () => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setIsSyncing(true);
    showToast({
      status: "syncing",
      message: "Syncing library with Dropbox...",
    });

    try {
      const result = await syncWithDropbox();
      const [timestamps, pinned, stats] = await Promise.all([
        getBookSortTimestamps(),
        getPinnedBookIds(),
        getAllBookDailyStats(),
      ]);

      setPinnedIds(pinned);
      setBookStats(stats);

      const deletedSet = new Set(result.deletedBookIds);
      setBooks((prev) => {
        const remaining = prev.filter((b) => !deletedSet.has(b.id));
        const existingIds = new Set(remaining.map((b) => b.id));
        const additions = result.downloadedBooks.filter(
          (b) => !existingIds.has(b.id),
        );
        return sortBooksList([...remaining, ...additions], timestamps, pinned);
      });

      const parts: string[] = [];
      if (result.uploadedBooksCount > 0) {
        parts.push(`↑ ${result.uploadedBooksCount} uploaded`);
      }
      if (result.downloadedBooks.length > 0) {
        parts.push(`↓ ${result.downloadedBooks.length} downloaded`);
      }
      if (result.deletedFromCloudCount > 0) {
        parts.push(`${result.deletedFromCloudCount} removed from cloud`);
      }
      if (result.deletedBookIds.length > 0) {
        parts.push(`${result.deletedBookIds.length} removed locally`);
      }
      if (result.metadataChanged) {
        parts.push("progress & highlights synced");
      }

      showToast(
        {
          status: "success",
          message:
            parts.length > 0
              ? `Synced — ${parts.join(", ")}`
              : "Sync complete — already up to date",
        },
        4000,
      );
    } catch (error) {
      if (error instanceof DropboxAuthError) {
        setIsLoggedInDropbox(false);
        showToast({ status: "error", message: error.message }, 6000);
      } else {
        console.error("Dropbox sync error:", error);
        showToast(
          {
            status: "error",
            message: "Sync failed. Please check your connection and try again.",
          },
          6000,
        );
      }
    } finally {
      syncInFlightRef.current = false;
      setIsSyncing(false);
    }
  }, [showToast]);

  // Initial load: books, theme, pins, reading stats, Dropbox auth + auto-sync
  useEffect(() => {
    let active = true;

    const initApp = async () => {
      try {
        const [keys, savedTheme] = await Promise.all([
          localforage.keys(),
          localforage.getItem<ShelfTheme>(SHELF_THEME_KEY),
        ]);

        if (!active) return;

        if (savedTheme === "dark" || savedTheme === "light") {
          setShelfTheme(savedTheme);
        }

        const bookKeys = keys.filter((key) => key.startsWith("book-"));
        const [savedBooks, timestamps, pinned, stats] = await Promise.all([
          Promise.all(bookKeys.map((key) => localforage.getItem<Book>(key))),
          getBookSortTimestamps(),
          getPinnedBookIds(),
          getAllBookDailyStats(),
        ]);

        if (!active) return;

        setPinnedIds(pinned);
        setBookStats(stats);
        setBooks(
          sortBooksList(savedBooks.filter(Boolean) as Book[], timestamps, pinned),
        );

        const connected = await initDropboxAuth();
        if (!active) return;

        setIsLoggedInDropbox(connected);
        if (connected) {
          void runSync();
        }
      } catch (error) {
        console.error("Failed to initialize library:", error);
      }
    };

    void initApp();

    return () => {
      active = false;
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, [runSync]);

  // Keep root page background synced with Shelf theme (independent from Reader theme)
  useEffect(() => {
    if (activeBook) return;
    const bg = shelfTheme === "light" ? "#f6f3eb" : "#121215";
    document.documentElement.style.backgroundColor = bg;
    document.body.style.backgroundColor = bg;
  }, [shelfTheme, activeBook]);

  const handleToggleShelfTheme = () => {
    setShelfTheme((prev) => {
      const next: ShelfTheme = prev === "dark" ? "light" : "dark";
      void localforage.setItem(SHELF_THEME_KEY, next);
      return next;
    });
  };

  const handleOpenBook = (book: Book) => {
    setActiveBook(book);
    void touchBookLastOpenedMeta(book.id);
    setBooks((prev) => {
      const reordered = [book, ...prev.filter((b) => b.id !== book.id)];
      const pinnedGroup = reordered.filter((b) =>
        pinnedIdsRef.current.has(b.id),
      );
      const unpinnedGroup = reordered.filter(
        (b) => !pinnedIdsRef.current.has(b.id),
      );
      return [...pinnedGroup, ...unpinnedGroup];
    });
  };

  const handleCloseBook = async () => {
    setActiveBook(null);
    await loadLibraryMetadata();
    if (isLoggedInDropbox) {
      void runSync();
    }
  };

  const handleDeleteBook = async (book: Book) => {
    if (!confirm(`Delete "${book.name}" from your library?`)) return;
    await deleteBookLocally(book.id);
    setBooks((prev) => prev.filter((b) => b.id !== book.id));
    setPinnedIds((prev) => {
      const next = new Set(prev);
      next.delete(book.id);
      return next;
    });
    setBookStats((prev) => {
      const next = { ...prev };
      delete next[book.id];
      return next;
    });
  };

  const handleTogglePin = async (book: Book) => {
    const nextPinned = !pinnedIds.has(book.id);
    const nextSet = new Set(pinnedIds);
    if (nextPinned) {
      nextSet.add(book.id);
    } else {
      nextSet.delete(book.id);
    }
    setPinnedIds(nextSet);
    await setBookPinnedMeta(book.id, nextPinned);
    const timestamps = await getBookSortTimestamps();
    setBooks((prev) => sortBooksList(prev, timestamps, nextSet));
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredBooks = normalizedQuery
    ? books.filter((b) => {
        const cleanName = b.name.replace(/\.epub$/i, "").toLowerCase();
        return (
          cleanName.includes(normalizedQuery) ||
          b.name.toLowerCase().includes(normalizedQuery)
        );
      })
    : books;

  const isLight = shelfTheme === "light";

  return (
    <>
      {!activeBook ? (
        <div
          className={`min-h-screen flex flex-col transition-colors duration-200 ${
            isLight
              ? "bg-[#f6f3eb] text-[#1c1917]"
              : "bg-[#121215] text-[#f4f4f5]"
          }`}
        >
          <Navigation
            setBooks={setBooks}
            pinnedIds={pinnedIds}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            shelfTheme={shelfTheme}
            onToggleShelfTheme={handleToggleShelfTheme}
            isLoggedInDropbox={isLoggedInDropbox}
            setIsLoggedInDropbox={setIsLoggedInDropbox}
            isSyncing={isSyncing}
            onSyncDropbox={runSync}
          />

          <Shelf
            books={filteredBooks}
            totalBooksCount={books.length}
            pinnedIds={pinnedIds}
            bookStats={bookStats}
            searchQuery={searchQuery}
            shelfTheme={shelfTheme}
            onOpenBook={handleOpenBook}
            onDeleteBook={handleDeleteBook}
            onTogglePin={handleTogglePin}
          />

          {/* Sync Status Notification Toast */}
          {syncToast && (
            <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 w-full max-w-md pointer-events-none">
              <div
                role="status"
                aria-live="polite"
                className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl border shadow-2xl backdrop-blur-md text-xs sm:text-sm font-medium transition-all ${
                  isLight
                    ? "bg-white/95 text-stone-800 border-stone-900/10"
                    : "bg-[#1c1c21]/95 text-zinc-100 border-white/10"
                }`}
              >
                {syncToast.status === "syncing" && (
                  <span
                    className={`w-4 h-4 rounded-full border-2 border-t-transparent animate-spin shrink-0 ${
                      isLight ? "border-blue-600" : "border-blue-400"
                    }`}
                  />
                )}
                {syncToast.status === "success" && (
                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                      isLight
                        ? "bg-emerald-600/15 text-emerald-700"
                        : "bg-emerald-500/20 text-emerald-300"
                    }`}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                )}
                {syncToast.status === "error" && (
                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                      isLight
                        ? "bg-rose-600/15 text-rose-700"
                        : "bg-rose-500/20 text-rose-300"
                    }`}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="9" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </span>
                )}

                <span className="flex-1 leading-snug">{syncToast.message}</span>

                {syncToast.status !== "syncing" && (
                  <button
                    type="button"
                    aria-label="Dismiss notification"
                    onClick={() => setSyncToast(null)}
                    className={`p-1 rounded-lg transition-colors shrink-0 ${
                      isLight
                        ? "text-stone-500 hover:bg-stone-900/10 hover:text-stone-800"
                        : "text-zinc-400 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    <svg
                      className="w-3.5 h-3.5"
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
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <Reader onClose={handleCloseBook} bookData={activeBook} />
      )}
    </>
  );
}

export default App;