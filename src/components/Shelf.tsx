import { useState, useEffect } from "react";
import type { Book, ShelfTheme } from "../App";
import type { BookDailyStat } from "../utils/sync";

interface ShelfProps {
  books: Book[];
  totalBooksCount: number;
  pinnedIds: Set<string>;
  bookStats: Record<string, BookDailyStat[]>;
  searchQuery: string;
  shelfTheme: ShelfTheme;
  onOpenBook: (book: Book) => void;
  onDeleteBook: (book: Book) => void;
  onTogglePin: (book: Book) => void;
}

const formatDisplayTitle = (name: string): string =>
  name.replace(/\.epub$/i, "");

const formatStatDate = (dateStr: string): string => {
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    return dateStr;
  }
  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

function Shelf({
  books,
  totalBooksCount,
  pinnedIds,
  bookStats,
  searchQuery,
  shelfTheme,
  onOpenBook,
  onDeleteBook,
  onTogglePin,
}: ShelfProps) {
  const [openMenu, setOpenMenu] = useState<{
    bookId: string;
    align: "left" | "right";
  } | null>(null);
  const [infoBook, setInfoBook] = useState<Book | null>(null);

  const isLight = shelfTheme === "light";

  useEffect(() => {
    if (!openMenu) return;
    const handleOutsideClick = () => setOpenMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("click", handleOutsideClick);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", handleOutsideClick);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!infoBook) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInfoBook(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [infoBook]);

  if (totalBooksCount === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none">
        <div
          className={`w-12 h-12 rounded-2xl border flex items-center justify-center mb-3 ${
            isLight
              ? "bg-stone-900/[0.04] border-stone-900/10 text-stone-400"
              : "bg-white/[0.04] border-white/10 text-zinc-500"
          }`}
        >
          <svg
            className="w-6 h-6"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        </div>
        <p
          className={`text-sm font-medium ${
            isLight ? "text-stone-700" : "text-zinc-300"
          }`}
        >
          No Books Imported
        </p>
        <p
          className={`text-xs mt-1 ${
            isLight ? "text-stone-500" : "text-zinc-500"
          }`}
        >
          Open the menu to import EPUB files
        </p>
      </div>
    );
  }

  if (books.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none">
        <p
          className={`text-sm font-medium ${
            isLight ? "text-stone-700" : "text-zinc-300"
          }`}
        >
          No books found for "{searchQuery.trim()}"
        </p>
      </div>
    );
  }

  const infoStats = infoBook ? (bookStats[infoBook.id] ?? []) : [];
  const latestPercentage =
    infoStats.length > 0
      ? Math.max(...infoStats.map((s) => s.percentage))
      : null;

  return (
    <>
      <main className="flex-1 p-3 sm:p-5">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
          {books.map((book) => {
            const isPinned = pinnedIds.has(book.id);
            const isMenuOpen = openMenu?.bookId === book.id;
            const menuAlign = openMenu?.align ?? "right";
            const displayTitle = formatDisplayTitle(book.name);

            return (
              <div key={book.id} className="group flex flex-col">
                <div
                  onClick={() => {
                    onOpenBook(book);
                    console.log("book clicked");
                  }}
                  className={`relative aspect-[2/3] w-full rounded-xl border cursor-pointer transition-transform duration-150 group-hover:-translate-y-0.5 shadow-md ${
                    isLight
                      ? "bg-stone-200/70 border-stone-900/10"
                      : "bg-[#1a1a1f] border-white/[0.08]"
                  }`}
                >
                  {/* Cover Image / Fallback */}
                  <div className="w-full h-full rounded-xl overflow-hidden">
                    {book.cover ? (
                      <img
                        src={book.cover}
                        alt={displayTitle}
                        className="w-full h-full object-cover block"
                      />
                    ) : (
                      <div
                        className={`w-full h-full p-4 flex flex-col items-center justify-center text-center ${
                          isLight
                            ? "bg-[#ede7da] text-stone-700"
                            : "bg-[#222229] text-zinc-300"
                        }`}
                      >
                        <span className="text-xs font-semibold leading-snug line-clamp-4">
                          {displayTitle}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Pinned Badge */}
                  {isPinned && (
                    <div
                      title="Pinned book"
                      className="absolute top-1 left-1 z-10 w-9 h-9 rounded-full bg-black/60 backdrop-blur-md border border-white/15 text-amber-300 flex items-center justify-center shadow-sm"
                    >
                      <svg
                        className="w-5 h-5"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path d="M16 3a1 1 0 0 1 .707 1.707L15 6.414V11l2.293 2.293A1 1 0 0 1 16.586 15H13v5.5a1 1 0 1 1-2 0V15H7.414a1 1 0 0 1-.707-1.707L9 11V6.414L7.293 4.707A1 1 0 0 1 8 3h8z" />
                      </svg>
                    </div>
                  )}

                  {/* Three-Dot Menu Button */}
                  <button
                    type="button"
                    aria-label={`Options for ${displayTitle}`}
                    title={`Options for ${displayTitle}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isMenuOpen) {
                        setOpenMenu(null);
                        return;
                      }
                      const rect = e.currentTarget.getBoundingClientRect();
                      const align = rect.left < 185 ? "left" : "right";
                      setOpenMenu({ bookId: book.id, align });
                    }}
                    className="absolute top-1 right-1 z-10 w-9 h-9 rounded-full bg-black/55 hover:bg-black/75 backdrop-blur-md text-white flex items-center justify-center border border-white/15 cursor-pointer transition-colors shadow-sm"
                  >
                    <svg
                      className="w-5 h-5"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <circle cx="12" cy="5.5" r="1.75" />
                      <circle cx="12" cy="12" r="1.75" />
                      <circle cx="12" cy="18.5" r="1.75" />
                    </svg>
                  </button>

                  {/* Dropdown Menu */}
                  {isMenuOpen && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className={`absolute top-11 ${
                        menuAlign === "left" ? "left-1" : "right-1"
                      } z-20 w-44 rounded-xl border shadow-2xl backdrop-blur-xl p-1.5 flex flex-col gap-0.5 ${
                        isLight
                          ? "bg-[#fdfaf3]/95 border-stone-900/10 text-stone-800"
                          : "bg-[#1d1d22]/95 border-white/10 text-zinc-100"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          onTogglePin(book);
                        }}
                        className={`w-full px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2.5 text-left transition-colors cursor-pointer ${
                          isLight
                            ? "hover:bg-stone-900/[0.06]"
                            : "hover:bg-white/[0.08]"
                        }`}
                      >
                        <svg
                          className={`w-3.5 h-3.5 shrink-0 ${
                            isPinned
                              ? isLight
                                ? "text-amber-600"
                                : "text-amber-300"
                              : ""
                          }`}
                          viewBox="0 0 24 24"
                          fill={isPinned ? "currentColor" : "none"}
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 17v5" />
                          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                        </svg>
                        <span>{isPinned ? "Unpin Book" : "Pin Book"}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          setInfoBook(book);
                        }}
                        className={`w-full px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2.5 text-left transition-colors cursor-pointer ${
                          isLight
                            ? "hover:bg-stone-900/[0.06]"
                            : "hover:bg-white/[0.08]"
                        }`}
                      >
                        <svg
                          className="w-3.5 h-3.5 shrink-0"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="9" />
                          <line x1="12" y1="16" x2="12" y2="12" />
                          <line x1="12" y1="8" x2="12.01" y2="8" />
                        </svg>
                        <span>Book Information</span>
                      </button>

                      <div
                        className={`my-0.5 border-t ${
                          isLight ? "border-stone-900/[0.07]" : "border-white/[0.07]"
                        }`}
                      />

                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          onDeleteBook(book);
                        }}
                        className={`w-full px-3 py-2 rounded-lg text-xs font-medium flex items-center gap-2.5 text-left transition-colors cursor-pointer ${
                          isLight
                            ? "text-rose-700 hover:bg-rose-600/10"
                            : "text-rose-300 hover:bg-rose-500/15"
                        }`}
                      >
                        <svg
                          className="w-3.5 h-3.5 shrink-0"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                        <span>Delete Book</span>
                      </button>
                    </div>
                  )}
                </div>

                {/* Subtle Book Title */}
                <p
                  onClick={() => {
                    onOpenBook(book);
                    console.log("book clicked");
                  }}
                  title={displayTitle}
                  className={`mt-2 px-0.5 text-xs font-medium truncate cursor-pointer ${
                    isLight ? "text-stone-700" : "text-zinc-300"
                  }`}
                >
                  {displayTitle}
                </p>
              </div>
            );
          })}
        </div>
      </main>

      {/* BOOK INFORMATION MODAL */}
      {infoBook && (
        <div
          onClick={() => setInfoBook(null)}
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm p-4 flex items-center justify-center"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-md max-h-[82vh] rounded-2xl border shadow-2xl flex flex-col overflow-hidden ${
              isLight
                ? "bg-[#fdfaf3] border-stone-900/10 text-stone-800"
                : "bg-[#18181c] border-white/10 text-zinc-100"
            }`}
          >
            {/* Modal Header */}
            <div
              className={`p-4 border-b flex items-start gap-3.5 ${
                isLight ? "border-stone-900/[0.08]" : "border-white/[0.08]"
              }`}
            >
              {infoBook.cover ? (
                <img
                  src={infoBook.cover}
                  alt={formatDisplayTitle(infoBook.name)}
                  className="w-12 h-16 rounded-lg object-cover shrink-0 border border-black/10"
                />
              ) : (
                <div
                  className={`w-12 h-16 rounded-lg shrink-0 flex items-center justify-center text-[10px] font-semibold p-1 text-center ${
                    isLight
                      ? "bg-stone-200 text-stone-600"
                      : "bg-white/10 text-zinc-400"
                  }`}
                >
                  EPUB
                </div>
              )}

              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-semibold leading-snug truncate">
                  {formatDisplayTitle(infoBook.name)}
                </h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  {pinnedIds.has(infoBook.id) && (
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                        isLight
                          ? "bg-amber-500/15 text-amber-800 border-amber-600/20"
                          : "bg-amber-500/15 text-amber-300 border-amber-400/20"
                      }`}
                    >
                      Pinned
                    </span>
                  )}
                  {latestPercentage !== null && (
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                        isLight
                          ? "bg-blue-600/10 text-blue-700 border-blue-600/20"
                          : "bg-blue-500/15 text-blue-300 border-blue-400/20"
                      }`}
                    >
                      Peak: {latestPercentage}%
                    </span>
                  )}
                </div>
              </div>

              <button
                type="button"
                aria-label="Close book information"
                onClick={() => setInfoBook(null)}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer shrink-0 ${
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

            {/* Modal Body: Daily Reading Log */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              <div className="flex items-center justify-between px-0.5">
                <span
                  className={`text-[10px] font-semibold uppercase tracking-widest ${
                    isLight ? "text-stone-500" : "text-zinc-400"
                  }`}
                >
                  Daily Reading Log
                </span>
                {infoStats.length > 0 && (
                  <span
                    className={`text-[11px] ${
                      isLight ? "text-stone-500" : "text-zinc-500"
                    }`}
                  >
                    {infoStats.length} day{infoStats.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {infoStats.length === 0 ? (
                <div
                  className={`rounded-xl border p-5 text-center ${
                    isLight
                      ? "bg-stone-900/[0.03] border-stone-900/[0.07]"
                      : "bg-white/[0.03] border-white/[0.07]"
                  }`}
                >
                  <p
                    className={`text-sm font-medium ${
                      isLight ? "text-stone-700" : "text-zinc-300"
                    }`}
                  >
                    No reading sessions recorded yet
                  </p>
                  <p
                    className={`text-xs mt-1 leading-relaxed ${
                      isLight ? "text-stone-500" : "text-zinc-500"
                    }`}
                  >
                    Open and read this book to track the percentage reached and
                    your reading speed (WPM) for each day.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {infoStats.map((stat) => (
                    <div
                      key={stat.date}
                      className={`rounded-xl border p-3 transition-colors ${
                        isLight
                          ? "bg-stone-900/[0.03] border-stone-900/[0.08]"
                          : "bg-white/[0.04] border-white/[0.08]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold">
                          {formatStatDate(stat.date)}
                        </span>
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[11px] font-medium px-2 py-0.5 rounded-md border ${
                              isLight
                                ? "bg-blue-600/10 text-blue-700 border-blue-600/15"
                                : "bg-blue-500/15 text-blue-300 border-blue-400/20"
                            }`}
                          >
                            {stat.percentage}% reached
                          </span>
                          <span
                            className={`text-[11px] font-medium px-2 py-0.5 rounded-md border ${
                              isLight
                                ? "bg-stone-900/[0.05] text-stone-700 border-stone-900/10"
                                : "bg-white/[0.07] text-zinc-200 border-white/10"
                            }`}
                          >
                            {stat.wpm > 0 ? `${stat.wpm} WPM` : "— WPM"}
                          </span>
                        </div>
                      </div>

                      {/* Slim progress indicator */}
                      <div
                        className={`mt-2.5 h-1.5 w-full rounded-full overflow-hidden ${
                          isLight ? "bg-stone-900/10" : "bg-white/10"
                        }`}
                      >
                        <div
                          className={`h-full rounded-full transition-all ${
                            isLight ? "bg-blue-600/80" : "bg-blue-400/80"
                          }`}
                          style={{ width: `${stat.percentage}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default Shelf;