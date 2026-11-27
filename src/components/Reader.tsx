import type { Book } from "../App";
import { useRef, useState, useEffect, useLayoutEffect } from "react";
import ePub, { EpubCFI } from "epubjs";
import localforage from "localforage";
import {
  touchProgressMeta,
  recordHighlightTombstone,
  clearHighlightTombstone,
  touchSettingsMeta,
  recordBookReadingStat,
} from "../utils/sync";

interface readerProps {
  bookData: Book;
  onClose: () => void;
}

interface tocItem {
  id: string;
  href: string;
  label: string;
  subitems?: tocItem[];
}

interface highlightItem {
  cfi: string;
  text: string;
  chapter?: string;
  percentage?: number;
  createdAt?: number;
}

interface SearchResult {
  cfi: string;
  excerpt: string;
  chapter: string;
  percentage?: number;
}

export default function Reader({ bookData, onClose }: readerProps) {
  // Global book search states
  const lookupCfiRef = useRef<string | null>(null);
  const overlayCfiRef = useRef<string | null>(null);
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayInputFocusedRef = useRef<boolean>(false);
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const searchIdRef = useRef<number>(0);
  const [backwardsOnly, setBackwardsOnly] = useState<boolean>(false);
  const prevSearchQueryRef = useRef<string>("");

  // Active reading WPM & daily progress tracking refs
  const readingAnchorRef = useRef<{ cfi: string; timestamp: number } | null>(
    null,
  );
  const visibleSinceRef = useRef<number | null>(
    document.visibilityState === "visible" ? Date.now() : null,
  );
  const accumulatedActiveMsRef = useRef<number>(0);
  const skipNextReadingTrackRef = useRef<boolean>(false);

  const viewerRef = useRef<HTMLDivElement>(null);
  const readerContainerRef = useRef<HTMLDivElement>(null);
  const contextCardRef = useRef<HTMLDivElement>(null);
  const [contextCardAnchor, setContextCardAnchor] = useState<{
    x: number;
    top: number;
    bottom: number;
  } | null>(null);
  const [contextCardCoords, setContextCardCoords] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const locationsPromiseRef = useRef<Promise<any> | null>(null);
  const pendingHighlight = useRef<{ cfi: string; contents: any } | null>(null);
  const lastTapViewportRef = useRef<{ x: number; y: number } | null>(null);

  const [selectionText, setSelectionText] = useState<string>("");
  const bookHighlightsKey = `highlights-${bookData.id}`;
  const bookLocationsKey = `locations-${bookData.id}`;

  const [highlightsList, setHighlightsList] = useState<highlightItem[]>([]);
  const [highlightsSearch, setHighlightsSearch] = useState<string>("");
  const [deleteMenu, setDeleteMenu] = useState<{ cfi: string } | null>(null);

  const [book, setBook] = useState<any>(null);
  const [rendition, setRendition] = useState<any>(null);
  const [pageInfo, setPageInfo] = useState<string>("Calculating");

  const [currentChapter, setCurrentChapter] =
    useState<string>("Unknown Chapter");
  const [currentPercentage, setCurrentPercentage] = useState<number>(0);
  const [currentChapterHref, setCurrentChapterHref] = useState<string>("");

  const [showHeaderFooter, setShowHeaderFooter] = useState<boolean>(false);

  // Sidebar and TOC states
  const [showSidebar, setShowSidebar] = useState<boolean>(false);
  const [sidebarTab, setSidebarTab] = useState<"toc" | "highlights" | "photos">(
    "toc",
  );
  const [photosList, setPhotosList] = useState<string[]>([]);
  const [photosLoading, setPhotosLoading] = useState<boolean>(false);
  const photoBlobUrlsRef = useRef<string[]>([]);
  const [toc, setToc] = useState<tocItem[]>([]);

  const highlightQuery = searchQuery.trim();
  const safeRegex = highlightQuery
    ? new RegExp(
        `(${highlightQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
        "gi",
      )
    : null;

  const [fontSize, setFontSize] = useState<number>(100);
  const [showFontMenu, setShowFontMenu] = useState<boolean>(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  // 1. Load saved font size and reader theme on initial mount
  useEffect(() => {
    const loadSavedSettings = async () => {
      const savedFontSize =
        await localforage.getItem<number>("reader-font-size");
      if (savedFontSize) {
        setFontSize(savedFontSize);
        console.log("saved font size applied", savedFontSize);
      }
      const savedTheme =
        await localforage.getItem<"dark" | "light">("reader-theme");
      if (savedTheme === "dark" || savedTheme === "light") {
        setTheme(savedTheme);
      }
    };
    loadSavedSettings();
  }, []);

  // Track tab visibility so backgrounded time never inflates/deflates WPM
  useEffect(() => {
    const handleVisibilityTrack = () => {
      const now = Date.now();
      if (document.visibilityState === "hidden") {
        if (visibleSinceRef.current !== null) {
          accumulatedActiveMsRef.current += now - visibleSinceRef.current;
          visibleSinceRef.current = null;
        }
      } else if (document.visibilityState === "visible") {
        if (visibleSinceRef.current === null) {
          visibleSinceRef.current = now;
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityTrack);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityTrack);
    };
  }, []);

  // Initialize book & rendition
  useEffect(() => {
    if (!viewerRef.current || !bookData.data) return;

    readingAnchorRef.current = null;
    accumulatedActiveMsRef.current = 0;
    visibleSinceRef.current =
      document.visibilityState === "visible" ? Date.now() : null;
    skipNextReadingTrackRef.current = false;

    const newBook = ePub(bookData.data);
    setBook(newBook);
    const newRendition = newBook.renderTo(viewerRef.current, {
      width: "100%",
      height: "100%",
      flow: "scrolled",
    } as any);

    newRendition.hooks.content.register((contents: any) => {
      const doc = contents.document;
      const body = doc.body;

      if (body) {
        body.setAttribute("tabindex", "-1");
        body.setAttribute("contenteditable", "true");
        body.setAttribute("inputmode", "none");
        body.setAttribute("spellcheck", "false");
        body.setAttribute("data-reader-content", "true");
      }

      const preventDefault = (e: Event) => {
        e.preventDefault();
      };
      doc.addEventListener("beforeinput", preventDefault);
      doc.addEventListener("paste", preventDefault);
      doc.addEventListener("cut", preventDefault);
      doc.addEventListener("drop", preventDefault);
      doc.addEventListener("contextmenu", preventDefault);

      const recordTapCoords = (e: MouseEvent | TouchEvent) => {
        const touch =
          "touches" in e && e.touches?.length
            ? e.touches[0]
            : "changedTouches" in e && e.changedTouches?.length
              ? e.changedTouches[0]
              : null;
        const cx = touch ? touch.clientX : (e as MouseEvent).clientX;
        const cy = touch ? touch.clientY : (e as MouseEvent).clientY;
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
        const iframeRect =
          doc.defaultView?.frameElement?.getBoundingClientRect();
        lastTapViewportRef.current = {
          x: (iframeRect?.left ?? 0) + cx,
          y: (iframeRect?.top ?? 0) + cy,
        };
      };
      doc.addEventListener("touchstart", recordTapCoords, {
        capture: true,
        passive: true,
      });
      doc.addEventListener("mousedown", recordTapCoords, true);
    });

    newRendition.themes.default({
      body: {
        "-webkit-touch-callout": "none",
        "caret-color": "transparent",
        outline: "none",
        color: "#c2c2c2",
        "max-width": "1000px !important",
        margin: "0 auto !important",
        padding: "0 10px !important",
      },
      "::selection": {
        background: "rgba(59, 130, 246, 0.3)",
      },
    });

    newBook.loaded.navigation.then((nav: any) => {
      setToc(nav.toc);
    });

    let lastKnownCfi: string | null = null;
    let hasCompletedInitialDisplay = false;

    const loadSavedPositions = async () => {
      const savedCfi = await localforage.getItem<string>(
        `progress-${bookData.id}`,
      );
      lastKnownCfi = savedCfi;
      if (savedCfi) {
        await newRendition.display(savedCfi);
        await newRendition.display(savedCfi);
        console.log("Saved cfi displayed,", savedCfi);
      } else {
        await newRendition.display();
      }
      hasCompletedInitialDisplay = true;

      const currentLoc = newRendition.currentLocation() as any;
      const startCfi = currentLoc?.start?.cfi || savedCfi;
      if (startCfi) {
        readingAnchorRef.current = { cfi: startCfi, timestamp: Date.now() };
        accumulatedActiveMsRef.current = 0;
        visibleSinceRef.current =
          document.visibilityState === "visible" ? Date.now() : null;
      }
    };

    loadSavedPositions();

    newBook.ready
      .then(async () => {
        const savedLocations =
          await localforage.getItem<string>(bookLocationsKey);

        if (savedLocations) {
          console.log("Found cached locations, loading instantly...");
          newBook.locations.load(savedLocations);
          locationsPromiseRef.current = Promise.resolve(newBook.locations);
        } else {
          console.log(
            "No cached locations found. Generating (this might take a while)...",
          );
          locationsPromiseRef.current = newBook.locations.generate(100);
          await locationsPromiseRef.current;
          await localforage.setItem(bookLocationsKey, newBook.locations.save());
          console.log("Locations generated and cached.");
        }

        return locationsPromiseRef.current;
      })
      .then((_locations: any) => {
        const currentLocation = newRendition.currentLocation() as any;
        if (currentLocation && currentLocation.start.displayed.total) {
          setPageInfo(
            `${currentLocation.start.displayed.page} / ${currentLocation.start.displayed.total}`,
          );
        }
      });

    newRendition.on("relocated", async (location: any) => {
      const now = Date.now();
      const newCfi: string = location.start.cfi;

      // Capture active reading time & words traversed synchronously before async awaits
      let wordsDelta = 0;
      let activeSecondsDelta = 0;
      let didUserReadMove = false;

      if (hasCompletedInitialDisplay) {
        const liveMs =
          visibleSinceRef.current !== null ? now - visibleSinceRef.current : 0;
        const elapsedSec = (accumulatedActiveMsRef.current + liveMs) / 1000;

        accumulatedActiveMsRef.current = 0;
        visibleSinceRef.current =
          document.visibilityState === "visible" ? now : null;

        const prevAnchor = readingAnchorRef.current;
        if (skipNextReadingTrackRef.current || !prevAnchor) {
          skipNextReadingTrackRef.current = false;
          readingAnchorRef.current = { cfi: newCfi, timestamp: now };
        } else {
          didUserReadMove = newCfi !== prevAnchor.cfi;
          try {
            const cfiHelper = (newRendition as any).epubcfi || new EpubCFI();
            const isForward = cfiHelper.compare(newCfi, prevAnchor.cfi) > 0;

            if (isForward && elapsedSec >= 1 && elapsedSec <= 180) {
              const r1 = newRendition.getRange(prevAnchor.cfi);
              const r2 = newRendition.getRange(newCfi);
              if (
                r1 &&
                r2 &&
                r1.startContainer?.ownerDocument &&
                r1.startContainer.ownerDocument ===
                  r2.startContainer?.ownerDocument
              ) {
                const doc = r1.startContainer.ownerDocument;
                const span = doc.createRange();
                span.setStart(r1.startContainer, r1.startOffset);
                span.setEnd(r2.startContainer, r2.startOffset);
                const segmentText = span.toString().trim();
                const count = segmentText
                  ? segmentText.split(/\s+/).filter(Boolean).length
                  : 0;
                const instantWpm = count > 0 ? (count / elapsedSec) * 60 : 0;
                if (
                  count >= 3 &&
                  count <= 2500 &&
                  instantWpm >= 20 &&
                  instantWpm <= 1000
                ) {
                  wordsDelta = count;
                  activeSecondsDelta = elapsedSec;
                }
              }
            }
          } catch {
            // Ignore transient range mismatch on chapter boundary
          }
          readingAnchorRef.current = { cfi: newCfi, timestamp: now };
        }
      }

      localforage.setItem(`progress-${bookData.id}`, newCfi);
      console.log("cfi saved", newCfi);

      if (!hasCompletedInitialDisplay) {
        if (!lastKnownCfi) {
          lastKnownCfi = newCfi;
        }
      } else if (newCfi !== lastKnownCfi) {
        lastKnownCfi = newCfi;
        touchProgressMeta(bookData.id);
      }

      if (location.start.displayed.total) {
        setPageInfo(
          `${location.start.displayed.page} / ${location.start.displayed.total}`,
        );
      }

      // 1. Get Current Chapter
      let chapter = "Unknown Chapter";
      let activeHref = "";
      try {
        const spineItem = newBook.spine.get(newCfi);
        if (spineItem) {
          const nav = await newBook.loaded.navigation;
          const bookToc = nav.toc;

          const searchToc = (
            items: tocItem[],
            href: string,
          ): tocItem | null => {
            for (const item of items) {
              if (item.href === href || item.href.split("#")[0] === href)
                return item;
              if (item.subitems && item.subitems.length > 0) {
                const found = searchToc(item.subitems, href);
                if (found) return found;
              }
            }
            return null;
          };

          const foundItem = searchToc(bookToc, spineItem.href);
          if (foundItem) {
            chapter = foundItem.label.trim();
            activeHref = foundItem.href;
          }
        }
      } catch (error) {
        console.error("Error fetching current chapter:", error);
      }
      setCurrentChapter(chapter);
      setCurrentChapterHref(activeHref);

      // 2. Get Current Percentage
      let percent = 0;
      try {
        if (locationsPromiseRef.current) {
          await locationsPromiseRef.current;
        }
        if (newBook.locations && newBook.locations.length() > 0) {
          const percentCfi = newBook.locations.percentageFromCfi(newCfi);
          if (percentCfi > 0) {
            percent = Math.round(percentCfi * 100);
          }
        }
      } catch (err) {
        console.error("Error waiting for locations to generate:", err);
      }
      setCurrentPercentage(percent);

      // 3. Persist daily percentage reached & WPM when user actually reads/moves
      if (hasCompletedInitialDisplay && (didUserReadMove || wordsDelta > 0)) {
        void recordBookReadingStat(bookData.id, {
          percentage: percent,
          ...(wordsDelta > 0 && activeSecondsDelta > 0
            ? { addedWords: wordsDelta, addedSeconds: activeSecondsDelta }
            : {}),
        });
      }
    });

    setRendition(newRendition);

    return () => {
      newBook.destroy();
    };
  }, [bookData]);

  // Apply and Save Fontsize whenever it changes
  useEffect(() => {
    if (rendition) {
      rendition.themes.fontSize(`${fontSize}%`);
      localforage.setItem("reader-font-size", fontSize);
      console.log("Font size applied", fontSize);
    }
  }, [fontSize, rendition]);

  useEffect(() => {
    if (!rendition) return;

    const isLight = theme === "light";
    rendition.themes.override(
      "background",
      isLight ? "#fbf5e6" : "#1c1c1c",
      true,
    );
    rendition.themes.override(
      "color",
      isLight ? "#2b2b2b" : "#c2c2c2",
      true,
    );
  }, [theme, rendition]);

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    localforage.setItem("reader-theme", nextTheme);
    touchSettingsMeta("theme");
  };

  // Navigation controls: keyboard, clicks, swipes
  useEffect(() => {
    if (!rendition) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        (target.isContentEditable && !target.closest?.("[data-reader-content]"))
      ) {
        return;
      }

      if (e.code === "Space") {
        if (e.shiftKey) {
          rendition.prev();
        } else rendition.next();
      }
    };

    const handleClick = (e: any) => {
      const iframeWindow = e.view || e.target?.ownerDocument?.defaultView;
      if (iframeWindow?.getSelection()?.toString().trim()) {
        return;
      }

      iframeWindow?.getSelection()?.removeAllRanges();
      (iframeWindow?.document?.activeElement as HTMLElement | null)?.blur?.();

      if (pendingHighlight.current) {
        closeContextUI();
        return;
      }

      setDeleteMenu(null);
      setContextCardAnchor(null);
      setShowFontMenu(false);

      const viewerWidth = viewerRef.current
        ? viewerRef.current.clientWidth
        : window.innerWidth;

      const clickX = e.clientX % viewerWidth;

      if (clickX < viewerWidth * 0.01) {
        rendition.prev();
      } else if (clickX > viewerWidth * 0.99) {
        rendition.next();
      } else {
        setShowHeaderFooter((prev) => !prev);
      }
    };

    let touchStartX = 0;
    let touchEndX = 0;

    const handleTouchStart = (e: any) => {
      touchStartX = e.changedTouches[0].screenX;
    };

    const handleTouchEnd = (e: any) => {
      touchEndX = e.changedTouches[0].screenX;

      const swipeDistance = touchStartX - touchEndX;
      if (swipeDistance > 200) {
        rendition.next();
      } else if (swipeDistance < -200) {
        rendition.prev();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    rendition.on("keydown", handleKeyDown);
    rendition.on("click", handleClick);
    rendition.on("touchstart", handleTouchStart);
    rendition.on("touchend", handleTouchEnd);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      rendition.off("keydown", handleKeyDown);
      rendition.off("click", handleClick);
      rendition.off("touchstart", handleTouchStart);
      rendition.off("touchend", handleTouchEnd);
    };
  }, [rendition]);

  const getCardAnchorFromRect = (
    rect: DOMRect | null | undefined,
    iframeEl: Element | null | undefined,
  ): { x: number; top: number; bottom: number } | null => {
    const container = readerContainerRef.current;
    if (!container || !rect) return null;

    const containerRect = container.getBoundingClientRect();
    const iframeRect = iframeEl?.getBoundingClientRect();
    const offsetX = iframeRect ? iframeRect.left : 0;
    const offsetY = iframeRect ? iframeRect.top : 0;

    return {
      x: offsetX + rect.left + rect.width / 2 - containerRect.left,
      top: offsetY + rect.top - containerRect.top,
      bottom: offsetY + rect.bottom - containerRect.top,
    };
  };

  const getCardAnchorFromPoint = (
    clientX: number,
    clientY: number,
    iframeEl: Element | null | undefined,
  ): { x: number; top: number; bottom: number } | null => {
    const container = readerContainerRef.current;
    if (!container) return null;

    const containerRect = container.getBoundingClientRect();
    const iframeRect = iframeEl?.getBoundingClientRect();
    const x = (iframeRect ? iframeRect.left : 0) + clientX - containerRect.left;
    const y = (iframeRect ? iframeRect.top : 0) + clientY - containerRect.top;

    return { x, top: y, bottom: y };
  };

  const attachHighlightAnnotation = (targetRendition: any, cfi: string) => {
    targetRendition.annotations.remove(cfi, "highlight");
    targetRendition.annotations.add(
      "highlight",
      cfi,
      {},
      (e: MouseEvent | TouchEvent) => {
        const targetEl = e.target as Element | null;
        const iframeEl = targetEl?.ownerDocument?.defaultView?.frameElement;
        const rect = targetEl?.getBoundingClientRect?.();
        const childRects = Array.from(
          targetEl?.querySelectorAll?.("rect") ?? [],
        )
          .map((r) => r.getBoundingClientRect())
          .filter((r) => r.width > 0 || r.height > 0);

        const tap = lastTapViewportRef.current;
        const matchedRect =
          tap && childRects.length > 0
            ? childRects.find(
                (r) =>
                  tap.x >= r.left - 8 &&
                  tap.x <= r.right + 8 &&
                  tap.y >= r.top - 8 &&
                  tap.y <= r.bottom + 8,
              )
            : null;

        const effectiveRect =
          matchedRect ||
          (rect && (rect.width > 0 || rect.height > 0) ? rect : childRects[0]);

        const rectAnchor = effectiveRect
          ? getCardAnchorFromRect(effectiveRect, iframeEl)
          : null;
        const tapAnchor = tap
          ? getCardAnchorFromPoint(tap.x, tap.y, null)
          : null;

        const anchor =
          rectAnchor && tapAnchor && matchedRect
            ? { x: tapAnchor.x, top: rectAnchor.top, bottom: rectAnchor.bottom }
            : rectAnchor || tapAnchor;

        pendingHighlight.current?.contents?.window
          ?.getSelection()
          ?.removeAllRanges();
        pendingHighlight.current = null;
        setSelectionText("");
        setDeleteMenu({ cfi });
        setContextCardAnchor(anchor);
        setShowHeaderFooter(true);
      },
      "epubjs-hl",
      {
        fill: "#3b82f6",
        "fill-opacity": "0.3",
        "mix-blend-mode": "normal",
      },
    );
  };

  const finalizeHighlight = async (cfiRange: string, contents: any) => {
    if (!rendition || !book || !pendingHighlight.current) return;

    contents?.window?.getSelection()?.removeAllRanges();
    pendingHighlight.current = null;

    attachHighlightAnnotation(rendition, cfiRange);

    const range = await book.getRange(cfiRange);
    const text = range.toString();

    let percentage = 0;
    try {
      if (locationsPromiseRef.current) {
        await locationsPromiseRef.current;
      }

      if (book.locations && book.locations.length() > 0) {
        const percentCfi = book.locations.percentageFromCfi(cfiRange);
        if (percentCfi > 0) {
          percentage = Math.round(percentCfi * 100);
        }
      }
    } catch (err) {
      console.error("Error waiting for locations to generate:", err);
    }

    let chapter = "Unknown Chapter";
    try {
      const spineItem = book.spine.get(cfiRange);
      if (spineItem) {
        const searchToc = (items: tocItem[], href: string): string | null => {
          for (const item of items) {
            if (item.href === href || item.href.split("#")[0] === href)
              return item.label;
            if (item.subitems && item.subitems.length > 0) {
              const found = searchToc(item.subitems, href);
              if (found) return found;
            }
          }
          return null;
        };

        const foundTitle = searchToc(toc, spineItem.href);
        if (foundTitle) chapter = foundTitle.trim();
      }
    } catch (error) {
      console.error("Error fetching chapter title for highlight:", error);
    }

    const existingHighlights: highlightItem[] =
      (await localforage.getItem(bookHighlightsKey)) || [];

    if (!existingHighlights.find((h) => h.cfi === cfiRange)) {
      existingHighlights.push({
        cfi: cfiRange,
        text: text,
        chapter,
        percentage,
        createdAt: Date.now(),
      });
      await localforage.setItem(bookHighlightsKey, existingHighlights);
      await clearHighlightTombstone(bookData.id, cfiRange);
    }
  };

  useEffect(() => {
    if (!rendition || !book) return;
    const handleSelected = (cfiRange: string, contents: any) => {
      const range = rendition.getRange(cfiRange);
      const text = range.toString().trim();
      const rect =
        range?.getBoundingClientRect?.() || range?.getClientRects?.()?.[0];
      const iframeEl =
        contents?.window?.frameElement ||
        viewerRef.current?.querySelector("iframe");

      setDeleteMenu(null);
      pendingHighlight.current = { cfi: cfiRange, contents };
      setSelectionText(text);
      setContextCardAnchor(getCardAnchorFromRect(rect, iframeEl));
      setShowHeaderFooter(true);
    };

    rendition.on("selected", handleSelected);

    return () => {
      rendition.off("selected", handleSelected);
    };
  }, [rendition, book]);

  useEffect(() => {
    if (!rendition) return;

    const applySavedHighlights = async () => {
      const savedHighlights: highlightItem[] =
        (await localforage.getItem(bookHighlightsKey)) || [];

      savedHighlights.forEach((hl) => {
        attachHighlightAnnotation(rendition, hl.cfi);
      });

      console.log(`Applied ${savedHighlights.length} highlights`);
    };

    rendition.on("rendered", applySavedHighlights);

    return () => {
      rendition.off("rendered", applySavedHighlights);
    };
  }, [rendition, bookData.id]);

  const handleRemoveHighlight = async (cfi: string) => {
    if (!rendition) return;

    rendition.annotations.remove(cfi, "highlight");

    const existingHighlights: highlightItem[] =
      (await localforage.getItem(bookHighlightsKey)) || [];
    const updatedHighlights = existingHighlights.filter((h) => h.cfi !== cfi);
    await localforage.setItem(bookHighlightsKey, updatedHighlights);
    await recordHighlightTombstone(bookData.id, cfi);

    setDeleteMenu(null);
    setContextCardAnchor(null);
  };

  useEffect(() => {
    if (showSidebar && sidebarTab === "toc") {
      const timer = setTimeout(() => {
        const activeEl = document.getElementById("active-toc-item");
        if (activeEl) {
          activeEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 50);

      return () => clearTimeout(timer);
    }
  }, [showSidebar, sidebarTab, currentChapterHref]);

  useEffect(() => {
    if (showSidebar && sidebarTab === "highlights") {
      const load = async () => {
        const data =
          await localforage.getItem<highlightItem[]>(bookHighlightsKey);

        if (data) {
          const sortedData = [...data].sort((a, b) =>
            b.cfi.localeCompare(a.cfi, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          );
          setHighlightsList(sortedData);
        } else {
          setHighlightsList([]);
        }
      };
      load();
    }
  }, [showSidebar, sidebarTab, bookHighlightsKey]);

  useEffect(() => {
    if (!showSidebar || sidebarTab !== "photos" || !book) return;

    setPhotosList([]);
    setPhotosLoading(true);

    let cancelled = false;

    const loadPhotos = async () => {
      try {
        await book.ready;
        const manifest = book.packaging.manifest;

        const imageItems = (Object.values(manifest) as any[])
          .filter(
            (item) =>
              typeof item.type === "string" && item.type.startsWith("image/"),
          )
          .sort((a, b) =>
            a.href.localeCompare(b.href, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          );

        console.log(`[Photos] ${imageItems.length} images sorted by href`);

        const urls: string[] = [];

        for (const item of imageItems as any[]) {
          if (cancelled) break;

          let url: string | null = null;

          try {
            const resolvedHref = book.path.resolve(item.href);
            if (book.archive && typeof book.archive.createUrl === "function") {
              url = await book.archive.createUrl(resolvedHref, {
                base64: false,
              });
            }
          } catch (e) {
            console.warn("[Photos] archive.createUrl failed for", item.href, e);
          }

          if (!url) {
            try {
              const blob = await book.load(item.href);
              if (blob instanceof Blob) {
                url = URL.createObjectURL(blob);
                photoBlobUrlsRef.current.push(url);
              }
            } catch (e) {
              console.warn("[Photos] book.load failed for", item.href, e);
            }
          }

          if (url) urls.push(url);
        }

        if (!cancelled) {
          setPhotosList(urls);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[Photos] Fatal error loading photos:", err);
          setPhotosList([]);
        }
      } finally {
        if (!cancelled) {
          setPhotosLoading(false);
        }
      }
    };

    loadPhotos();

    return () => {
      cancelled = true;
      photoBlobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      photoBlobUrlsRef.current = [];
    };
  }, [showSidebar, sidebarTab, book]);

  const filteredHighlights = highlightsList.filter((hl) => {
    return hl.text.toLowerCase().includes(highlightsSearch.toLowerCase());
  });

  const isLight = theme === "light";

  const getCurrentCfi = (): string | null =>
    rendition?.currentLocation?.()?.start?.cfi ||
    rendition?.location?.start?.cfi ||
    null;

  const displayCfi = async (cfi: string) => {
    if (!rendition) return;
    skipNextReadingTrackRef.current = true;
    await rendition.display(cfi);
    await rendition.display(cfi);
  };

  const scheduleCfiRestore = (cfi: string | null) => {
    if (!cfi || !rendition) return;
    if (restoreTimerRef.current) {
      clearTimeout(restoreTimerRef.current);
    }
    restoreTimerRef.current = setTimeout(() => {
      restoreTimerRef.current = null;
      displayCfi(cfi);
    }, 250);
  };

  const openOverlayWithCfi = (setOverlayOpen: (open: boolean) => void) => {
    if (restoreTimerRef.current) {
      clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
    }
    overlayCfiRef.current = getCurrentCfi();
    overlayInputFocusedRef.current = false;
    setOverlayOpen(true);
    setShowHeaderFooter(false);
  };

  const closeOverlayAndRestore = (setOverlayOpen: (open: boolean) => void) => {
    const cfi = overlayCfiRef.current;
    overlayCfiRef.current = null;
    overlayInputFocusedRef.current = false;
    setOverlayOpen(false);
    scheduleCfiRestore(cfi);
  };

  const renderHighlights = () => {
    if (filteredHighlights.length === 0) {
      return (
        <p
          className={`p-6 text-center text-xs ${
            isLight ? "text-stone-500" : "text-zinc-500"
          }`}
        >
          {highlightsSearch
            ? "No matching highlights found"
            : "No highlights yet"}
        </p>
      );
    }

    return (
      <div className="p-2 space-y-1">
        {filteredHighlights.map((item, index) => (
          <button
            key={item.cfi || index}
            className={`text-left w-full p-3 rounded-xl border transition-colors cursor-pointer ${
              isLight
                ? "border-stone-900/[0.06] hover:bg-stone-900/[0.05] text-stone-800"
                : "border-white/[0.06] hover:bg-white/[0.06] text-zinc-200"
            }`}
            onClick={async () => {
              const hadInputFocus = overlayInputFocusedRef.current;
              overlayCfiRef.current = null;
              overlayInputFocusedRef.current = false;
              setShowSidebar(false);
              await displayCfi(item.cfi);
              if (hadInputFocus) {
                scheduleCfiRestore(item.cfi);
              }
            }}
          >
            <div
              className={`w-full flex justify-between items-start text-[10px] uppercase tracking-widest font-semibold mb-1.5 ${
                isLight ? "text-stone-500" : "text-zinc-400"
              }`}
            >
              <span className="truncate pr-2">
                {item.chapter || "Unknown Chapter"}
              </span>
              <span className="shrink-0">
                {item.percentage !== undefined ? `${item.percentage}%` : ""}
              </span>
            </div>

            <p className="text-xs sm:text-sm italic leading-relaxed">
              "{item.text}"
            </p>
          </button>
        ))}
      </div>
    );
  };

  const renderToc = (items: tocItem[], level = 0) => {
    return items.map((item, index) => {
      const isActive = item.href === currentChapterHref;

      return (
        <div key={item.id || index}>
          <button
            id={isActive ? "active-toc-item" : undefined}
            className={`w-full py-2.5 pr-3 rounded-xl flex justify-between items-center transition-colors text-left text-xs sm:text-sm cursor-pointer ${
              isActive
                ? isLight
                  ? "bg-amber-500/15 text-amber-800 font-semibold"
                  : "bg-amber-500/15 text-amber-300 font-semibold"
                : isLight
                  ? "text-stone-700 hover:bg-stone-900/[0.05]"
                  : "text-zinc-200 hover:bg-white/[0.06]"
            }`}
            style={{ paddingLeft: `${level * 1.1 + 0.75}rem` }}
            onClick={async () => {
              overlayCfiRef.current = null;
              overlayInputFocusedRef.current = false;
              skipNextReadingTrackRef.current = true;
              await rendition.display(item.href);
              setShowSidebar(false);
              setShowHeaderFooter(false);
            }}
          >
            <span className="truncate pr-3">{item.label}</span>
            {isActive && (
              <svg
                className="w-3.5 h-3.5 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
          {item.subitems &&
            item.subitems.length > 0 &&
            renderToc(item.subitems, level + 1)}
        </div>
      );
    });
  };

  const handleDictionaryLookup = () => {
    if (!selectionText) return;

    const word = selectionText
      .split(/\s+/)[0]
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent("define " + word)}`;
    lookupCfiRef.current = getCurrentCfi();
    window.open(searchUrl, "_blank", "noopener,noreferrer");
    closeContextUI();
  };

  useEffect(() => {
    if (!rendition) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && lookupCfiRef.current) {
        const cfi = lookupCfiRef.current;
        lookupCfiRef.current = null;
        scheduleCfiRestore(cfi);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (restoreTimerRef.current) {
        clearTimeout(restoreTimerRef.current);
        restoreTimerRef.current = null;
      }
    };
  }, [rendition]);

  const closeContextUI = () => {
    pendingHighlight.current?.contents?.window
      ?.getSelection()
      ?.removeAllRanges();

    pendingHighlight.current = null;
    setSelectionText("");
    setContextCardAnchor(null);
    setShowHeaderFooter(false);
  };

  const handleFinalizePendingHighlight = () => {
    if (!pendingHighlight.current) return;
    const { cfi, contents } = pendingHighlight.current;
    finalizeHighlight(cfi, contents);
    closeContextUI();
  };

  const handleSearchSelection = () => {
    const selected = selectionText.replace(/\s+/g, " ").trim();
    openOverlayWithCfi(setShowSearch);
    if (selected) {
      prevSearchQueryRef.current = selected;
      setSearchQuery(selected);
      closeContextUI();
    }
  };

  useLayoutEffect(() => {
    const container = readerContainerRef.current;
    const card = contextCardRef.current;
    if (!contextCardAnchor || !container || !card) {
      setContextCardCoords(null);
      return;
    }

    const cardWidth = card.offsetWidth;
    const cardHeight = card.offsetHeight;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const minTop = showHeaderFooter ? 68 : 12;
    const maxTop = Math.max(
      minTop,
      containerHeight - cardHeight - (showHeaderFooter ? 64 : 32),
    );

    const left = Math.max(
      8,
      Math.min(
        contextCardAnchor.x - cardWidth / 2,
        containerWidth - cardWidth - 8,
      ),
    );

    const aboveTop = contextCardAnchor.top - cardHeight - 10;
    const belowTop = contextCardAnchor.bottom + 14;
    const preferredTop = aboveTop >= minTop ? aboveTop : belowTop;
    const top = Math.max(minTop, Math.min(preferredTop, maxTop));

    setContextCardCoords({ left, top });
  }, [contextCardAnchor, showHeaderFooter, selectionText, deleteMenu]);

  const executeSearch = async (query: string) => {
    if (!book || !query.trim()) return;

    const currentSearchId = ++searchIdRef.current;

    setIsSearching(true);
    setSearchResults([]);

    try {
      if (locationsPromiseRef.current) {
        await locationsPromiseRef.current;
      }

      const currentLoc =
        (await rendition?.currentLocation?.()) || rendition?.location;
      const cutoffCfi = currentLoc?.end?.cfi || currentLoc?.start?.cfi;
      const currentSpineIndex =
        currentLoc?.end?.index ?? currentLoc?.start?.index ?? null;
      const cfiHelper = rendition?.epubcfi || new EpubCFI();

      const results: SearchResult[] = [];
      const spineItems = book.spine.spineItems;

      for (let i = 0; i < spineItems.length; i++) {
        if (currentSearchId !== searchIdRef.current) return;

        const item = spineItems[i];
        if (
          backwardsOnly &&
          currentSpineIndex !== null &&
          (item.index ?? i) > currentSpineIndex
        ) {
          break;
        }
        await item.load(book.load.bind(book));
        const matches = item.find(query);

        const expandedMatches: { cfi: string; excerpt: string }[] = [];

        if (matches && matches.length > 0) {
          for (const match of matches) {
            if (backwardsOnly && cutoffCfi) {
              try {
                const matchCfi = new EpubCFI(match.cfi);
                matchCfi.collapse(true);
                if (cfiHelper.compare(matchCfi, cutoffCfi) > 0) {
                  continue;
                }
              } catch {
                // ignore malformed CFI comparison
              }
            }
            let fullExcerpt = match.excerpt;
            try {
              const range = await book.getRange(match.cfi);
              if (range && range.startContainer) {
                let node: any = range.startContainer;
                if (node.nodeType === 3) node = node.parentNode;

                const block =
                  node.closest?.(
                    "p, div, section, li, h1, h2, h3, h4, h5, h6",
                  ) || node;
                if (block && block.textContent) {
                  fullExcerpt = block.textContent.replace(/\s+/g, " ").trim();
                }
              }
            } catch (err) {
              console.warn("Could not expand excerpt context", err);
            }
            expandedMatches.push({ cfi: match.cfi, excerpt: fullExcerpt });
          }
        }

        item.unload();

        if (expandedMatches.length > 0) {
          const searchToc = (
            items: tocItem[],
            targetHref: string,
          ): string | null => {
            for (const t of items) {
              if (t.href === targetHref || t.href.split("#")[0] === targetHref)
                return t.label;
              if (t.subitems && t.subitems.length > 0) {
                const found = searchToc(t.subitems, targetHref);
                if (found) return found;
              }
            }
            return null;
          };

          const chapterName = searchToc(toc, item.href) || "Unknown Chapter";

          for (const match of expandedMatches) {
            let percentage = 0;
            if (book.locations && book.locations.length() > 0) {
              const percentCfi = book.locations.percentageFromCfi(match.cfi);
              if (percentCfi > 0) {
                percentage = Math.round(percentCfi * 100);
              }
            }

            results.push({
              cfi: match.cfi,
              excerpt: match.excerpt,
              chapter: chapterName.trim(),
              percentage,
            });
          }

          if (currentSearchId === searchIdRef.current) {
            setSearchResults([...results]);
          }
        }
      }

      if (currentSearchId === searchIdRef.current) {
        setIsSearching(false);
      }
    } catch (error) {
      console.error("Search failed:", error);
      if (currentSearchId === searchIdRef.current) setIsSearching(false);
    }
  };

  useEffect(() => {
    if (!showSearch) return;

    const queryChanged = prevSearchQueryRef.current !== searchQuery;
    prevSearchQueryRef.current = searchQuery;

    if (!searchQuery.trim()) {
      searchIdRef.current++;
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    if (!queryChanged) {
      executeSearch(searchQuery);
      return;
    }

    const delayFn = setTimeout(() => {
      executeSearch(searchQuery);
    }, 1000);

    return () => clearTimeout(delayFn);
  }, [searchQuery, backwardsOnly, showSearch]);

  return (
    <>
      <div
        ref={readerContainerRef}
        className="flex flex-col absolute w-full h-full top-0 overflow-hidden"
      >
        {/* TOP BAR */}
        {showHeaderFooter && (
          <div
            className={`absolute top-0 left-0 w-full z-10 flex justify-between items-center px-3 py-2.5 border-b backdrop-blur-md shadow-sm ${
              isLight
                ? "bg-[#f4ecd8]/92 text-stone-800 border-stone-900/10"
                : "bg-[#18181c]/92 text-zinc-100 border-white/[0.08]"
            }`}
          >
            <button
              onClick={() => openOverlayWithCfi(setShowSidebar)}
              className={`rounded-xl py-2 px-3 text-sm font-medium flex items-center gap-2 transition-colors cursor-pointer ${
                isLight
                  ? "hover:bg-stone-900/[0.07] text-stone-800"
                  : "hover:bg-white/[0.08] text-zinc-100"
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
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
              <span>Menu</span>
            </button>

            <button
              onClick={onClose}
              className={`rounded-xl px-3.5 py-2 text-xs sm:text-sm font-medium border transition-colors cursor-pointer ${
                isLight
                  ? "bg-rose-600/12 hover:bg-rose-600/20 text-rose-700 border-rose-600/20"
                  : "bg-rose-500/16 hover:bg-rose-500/26 text-rose-300 border-rose-400/25"
              }`}
            >
              Close
            </button>
          </div>
        )}

        {/* SEARCH OVERLAY CARD */}
        {showSearch && (
          <div
            onClick={() => closeOverlayAndRestore(setShowSearch)}
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className={`w-full max-w-lg h-[80%] max-h-[700px] rounded-2xl shadow-2xl border flex flex-col overflow-hidden ${
                isLight
                  ? "bg-[#fdfaf3] border-stone-900/10 text-stone-800"
                  : "bg-[#18181c] border-white/10 text-zinc-100"
              }`}
            >
              {/* Search Card Header */}
              <div
                className={`flex items-center justify-between px-4 py-3.5 border-b ${
                  isLight ? "border-stone-900/[0.08]" : "border-white/[0.08]"
                }`}
              >
                <h2 className="text-sm font-semibold tracking-tight">
                  Search Book
                </h2>
                <button
                  onClick={() => closeOverlayAndRestore(setShowSearch)}
                  aria-label="Close search"
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

              {/* Search Input Area */}
              <div
                className={`p-4 border-b flex flex-col gap-3 ${
                  isLight
                    ? "border-stone-900/[0.08] bg-stone-900/[0.02]"
                    : "border-white/[0.08] bg-white/[0.02]"
                }`}
              >
                <input
                  type="text"
                  placeholder="Start typing to search..."
                  value={searchQuery}
                  onFocus={() => {
                    overlayInputFocusedRef.current = true;
                  }}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`w-full rounded-xl px-3.5 py-2 text-sm border focus:outline-none transition-colors ${
                    isLight
                      ? "bg-white border-stone-900/10 text-stone-800 placeholder-stone-400 focus:border-blue-600/50"
                      : "bg-white/[0.05] border-white/10 text-zinc-100 placeholder-zinc-500 focus:border-blue-400/50"
                  }`}
                />

                <button
                  type="button"
                  role="switch"
                  aria-checked={backwardsOnly}
                  onClick={() => setBackwardsOnly((prev) => !prev)}
                  className="w-full flex items-center justify-between cursor-pointer select-none"
                >
                  <span
                    className={`text-xs font-medium ${
                      isLight ? "text-stone-600" : "text-zinc-300"
                    }`}
                  >
                    Backwards only
                  </span>
                  <span
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      backwardsOnly
                        ? isLight
                          ? "bg-blue-600"
                          : "bg-blue-500"
                        : isLight
                          ? "bg-stone-900/15"
                          : "bg-white/20"
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        backwardsOnly ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>
              </div>

              {/* Search Results Area */}
              <div className="flex-1 overflow-y-auto p-2">
                {searchResults.length > 0 ? (
                  <div className="space-y-1">
                    {searchResults.map((res, i) => (
                      <button
                        key={i}
                        onClick={async () => {
                          const hadInputFocus = overlayInputFocusedRef.current;
                          overlayCfiRef.current = null;
                          overlayInputFocusedRef.current = false;
                          setShowSearch(false);
                          await displayCfi(res.cfi);
                          if (hadInputFocus) {
                            scheduleCfiRestore(res.cfi);
                          }
                        }}
                        className={`w-full text-left p-3.5 rounded-xl border transition-colors cursor-pointer ${
                          isLight
                            ? "border-stone-900/[0.06] hover:bg-stone-900/[0.04]"
                            : "border-white/[0.06] hover:bg-white/[0.05]"
                        }`}
                      >
                        <div
                          className={`flex justify-between items-start text-[10px] uppercase tracking-widest font-semibold mb-1.5 ${
                            isLight ? "text-stone-500" : "text-zinc-400"
                          }`}
                        >
                          <span className="truncate pr-2">{res.chapter}</span>
                          <span className="shrink-0">{res.percentage}%</span>
                        </div>

                        <p
                          className={`text-xs sm:text-sm italic leading-relaxed ${
                            isLight ? "text-stone-700" : "text-zinc-300"
                          }`}
                        >
                          {safeRegex
                            ? (res.excerpt || "")
                                .split(safeRegex)
                                .map((part, index) =>
                                  part.toLowerCase() ===
                                  highlightQuery.toLowerCase() ? (
                                    <mark
                                      key={index}
                                      className={`rounded px-1 ${
                                        isLight
                                          ? "bg-amber-400/40 text-stone-900"
                                          : "bg-amber-400/30 text-amber-100"
                                      }`}
                                    >
                                      {part}
                                    </mark>
                                  ) : (
                                    part
                                  ),
                                )
                            : res.excerpt}
                        </p>
                      </button>
                    ))}

                    {isSearching && (
                      <div
                        className={`text-center py-4 text-[10px] uppercase tracking-widest animate-pulse font-semibold ${
                          isLight ? "text-stone-500" : "text-zinc-500"
                        }`}
                      >
                        Scanning remaining chapters...
                      </div>
                    )}
                  </div>
                ) : isSearching ? (
                  <div
                    className={`flex flex-col items-center justify-center h-full gap-3 ${
                      isLight ? "text-stone-500" : "text-zinc-400"
                    }`}
                  >
                    <span
                      className={`w-6 h-6 rounded-full border-2 border-t-transparent animate-spin ${
                        isLight ? "border-blue-600" : "border-blue-400"
                      }`}
                    />
                    <p className="text-xs sm:text-sm">Scanning entire book...</p>
                  </div>
                ) : searchQuery ? (
                  <p
                    className={`text-center mt-10 text-xs sm:text-sm ${
                      isLight ? "text-stone-500" : "text-zinc-500"
                    }`}
                  >
                    No results found for "{searchQuery}".
                  </p>
                ) : (
                  <p
                    className={`text-center mt-10 text-xs sm:text-sm ${
                      isLight ? "text-stone-500" : "text-zinc-500"
                    }`}
                  >
                    Type a keyword to begin searching.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* FLOATING MINIMALIST SIDEBAR (50% width, rounded corners, inset from all edges) */}
        {showSidebar && (
          <div
            onClick={() => closeOverlayAndRestore(setShowSidebar)}
            className="fixed inset-0 z-20 bg-black/45 backdrop-blur-sm p-3 sm:p-5 flex items-stretch justify-start"
          >
            <aside
              onClick={(e) => e.stopPropagation()}
              className={`w-1/2 min-w-[80%] h-full rounded-2xl border shadow-2xl flex flex-col overflow-hidden ${
                isLight
                  ? "bg-[#fdfaf3]/95 border-stone-900/10 text-stone-800"
                  : "bg-[#18181c]/95 border-white/10 text-zinc-100"
              }`}
            >
              {/* Segmented Tabs Header */}
              <div
                className={`p-2.5 border-b ${
                  isLight ? "border-stone-900/[0.08]" : "border-white/[0.08]"
                }`}
              >
                <div
                  className={`p-1 rounded-xl grid grid-cols-3 gap-1 ${
                    isLight ? "bg-stone-900/[0.05]" : "bg-white/[0.05]"
                  }`}
                >
                  <button
                    className={`py-1.5 px-1 rounded-lg text-[11px] sm:text-xs font-semibold transition-colors cursor-pointer truncate ${
                      sidebarTab === "toc"
                        ? isLight
                          ? "bg-white text-stone-900 shadow-sm"
                          : "bg-white/15 text-white shadow-sm"
                        : isLight
                          ? "text-stone-500 hover:text-stone-800"
                          : "text-zinc-400 hover:text-zinc-200"
                    }`}
                    onClick={() => setSidebarTab("toc")}
                  >
                    Chapters
                  </button>
                  <button
                    className={`py-1.5 px-1 rounded-lg text-[11px] sm:text-xs font-semibold transition-colors cursor-pointer truncate ${
                      sidebarTab === "highlights"
                        ? isLight
                          ? "bg-white text-stone-900 shadow-sm"
                          : "bg-white/15 text-white shadow-sm"
                        : isLight
                          ? "text-stone-500 hover:text-stone-800"
                          : "text-zinc-400 hover:text-zinc-200"
                    }`}
                    onClick={() => setSidebarTab("highlights")}
                  >
                    Highlights
                  </button>
                  <button
                    className={`py-1.5 px-1 rounded-lg text-[11px] sm:text-xs font-semibold transition-colors cursor-pointer truncate ${
                      sidebarTab === "photos"
                        ? isLight
                          ? "bg-white text-stone-900 shadow-sm"
                          : "bg-white/15 text-white shadow-sm"
                        : isLight
                          ? "text-stone-500 hover:text-stone-800"
                          : "text-zinc-400 hover:text-zinc-200"
                    }`}
                    onClick={() => setSidebarTab("photos")}
                  >
                    Photos
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto">
                {sidebarTab === "toc" && (
                  <div className="p-2 flex flex-col gap-0.5">
                    {toc.length > 0 ? (
                      renderToc(toc)
                    ) : (
                      <p
                        className={`p-4 text-center text-xs ${
                          isLight ? "text-stone-500" : "text-zinc-500"
                        }`}
                      >
                        No Table of Contents found.
                      </p>
                    )}
                  </div>
                )}

                {sidebarTab === "highlights" && (
                  <div className="flex flex-col h-full overflow-hidden">
                    <div className="flex-1 overflow-y-auto">
                      {renderHighlights()}
                    </div>

                    <div
                      className={`p-2.5 border-t ${
                        isLight
                          ? "border-stone-900/[0.08]"
                          : "border-white/[0.08]"
                      }`}
                    >
                      <div className="relative">
                        <input
                          type="text"
                          placeholder="Search highlights..."
                          value={highlightsSearch}
                          onFocus={() => {
                            overlayInputFocusedRef.current = true;
                          }}
                          onChange={(e) => setHighlightsSearch(e.target.value)}
                          className={`w-full rounded-xl px-3.5 py-2 pr-8 text-xs sm:text-sm border focus:outline-none transition-colors ${
                            isLight
                              ? "bg-white border-stone-900/10 text-stone-800 placeholder-stone-400 focus:border-blue-600/50"
                              : "bg-white/[0.05] border-white/10 text-zinc-100 placeholder-zinc-500 focus:border-blue-400/50"
                          }`}
                        />
                        {highlightsSearch && (
                          <button
                            onClick={() => setHighlightsSearch("")}
                            aria-label="Clear highlights search"
                            className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded cursor-pointer ${
                              isLight
                                ? "text-stone-400 hover:text-stone-700"
                                : "text-zinc-400 hover:text-white"
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
                  </div>
                )}

                {sidebarTab === "photos" && (
                  <>
                    {photosLoading ? (
                      <div
                        className={`flex items-center justify-center h-40 text-xs ${
                          isLight ? "text-stone-500" : "text-zinc-500"
                        }`}
                      >
                        Loading images...
                      </div>
                    ) : photosList.length === 0 ? (
                      <p
                        className={`p-4 text-center text-xs ${
                          isLight ? "text-stone-500" : "text-zinc-500"
                        }`}
                      >
                        No images found in this book.
                      </p>
                    ) : (
                      <>
                        <p
                          className={`text-[10px] uppercase tracking-widest font-semibold text-center py-2 border-b ${
                            isLight
                              ? "text-stone-400 border-stone-900/[0.08]"
                              : "text-zinc-500 border-white/[0.08]"
                          }`}
                        >
                          {photosList.length} image
                          {photosList.length !== 1 ? "s" : ""}
                        </p>
                        <div className="grid grid-cols-2 gap-2.5 p-3">
                          {photosList.map((url, index) => (
                            <button
                              key={index}
                              onClick={() => {
                                lookupCfiRef.current = getCurrentCfi();
                                window.open(
                                  url,
                                  "_blank",
                                  "noopener,noreferrer",
                                );
                              }}
                              className={`aspect-square rounded-xl overflow-hidden border transition-all cursor-pointer ${
                                isLight
                                  ? "bg-stone-900/[0.04] border-stone-900/10 hover:ring-2 hover:ring-blue-600/50"
                                  : "bg-white/[0.05] border-white/10 hover:ring-2 hover:ring-blue-400/50"
                              }`}
                            >
                              <img
                                src={url}
                                alt={`Book image ${index + 1}`}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  const btn = (
                                    e.target as HTMLImageElement
                                  ).closest("button");
                                  if (btn) btn.style.display = "none";
                                }}
                              />
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </aside>
          </div>
        )}

        {/* THE VIEWER */}
        <div
          ref={viewerRef}
          className={`flex-1 overflow-hidden relative z-0 [&_.epub-container]:overflow-x-hidden [&_.epub-container]:[scrollbar-width:none] [&_.epub-container::-webkit-scrollbar]:hidden ${
            isLight ? "bg-[#fbf5e6]" : "bg-[#1c1c1c]"
          }`}
        ></div>

        {/* FLOATING CONTEXT CARD FOR SELECTED TEXT / CLICKED HIGHLIGHT */}
        {!showSidebar &&
          !showSearch &&
          contextCardAnchor &&
          (selectionText || deleteMenu) && (
            <div
              ref={contextCardRef}
              style={{
                left: contextCardCoords ? `${contextCardCoords.left}px` : "0px",
                top: contextCardCoords ? `${contextCardCoords.top}px` : "0px",
                visibility: contextCardCoords ? "visible" : "hidden",
              }}
              className={`absolute z-[15] rounded-2xl p-1.5 flex items-center gap-1.5 shadow-2xl border backdrop-blur-xl whitespace-nowrap ${
                isLight
                  ? "bg-[#fdfaf3]/95 text-stone-800 border-stone-900/10"
                  : "bg-[#1e1e24]/95 text-zinc-100 border-white/10"
              }`}
            >
              {deleteMenu ? (
                <>
                  <button
                    onClick={() => handleRemoveHighlight(deleteMenu.cfi)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition-colors cursor-pointer ${
                      isLight
                        ? "bg-rose-600/12 hover:bg-rose-600/20 text-rose-700 border-rose-600/20"
                        : "bg-rose-500/18 hover:bg-rose-500/28 text-rose-300 border-rose-400/25"
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
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                    </svg>
                    <span>Delete Highlight</span>
                  </button>
                  <button
                    onClick={() => {
                      setDeleteMenu(null);
                      setContextCardAnchor(null);
                    }}
                    aria-label="Close context card"
                    className={`p-1.5 rounded-xl text-xs transition-colors cursor-pointer ${
                      isLight
                        ? "hover:bg-stone-900/[0.08] text-stone-500"
                        : "hover:bg-white/[0.1] text-zinc-400"
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
                </>
              ) : (
                <>
                  <button
                    onClick={handleDictionaryLookup}
                    className={`px-2.5 py-1.5 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition-colors cursor-pointer ${
                      isLight
                        ? "bg-stone-900/[0.06] hover:bg-stone-900/[0.12] text-stone-800 border-stone-900/10"
                        : "bg-white/[0.08] hover:bg-white/[0.14] text-zinc-100 border-white/10"
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
                      <circle cx="12" cy="12" r="9" />
                      <line x1="3.6" y1="9" x2="20.4" y2="9" />
                      <line x1="3.6" y1="15" x2="20.4" y2="15" />
                      <path d="M12 3a14.5 14.5 0 0 0 0 18" />
                      <path d="M12 3a14.5 14.5 0 0 1 0 18" />
                    </svg>
                    <span>Define</span>
                  </button>
                  <button
                    onClick={handleSearchSelection}
                    className={`px-2.5 py-1.5 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition-colors cursor-pointer ${
                      isLight
                        ? "bg-blue-600/12 hover:bg-blue-600/20 text-blue-700 border-blue-600/20"
                        : "bg-blue-500/18 hover:bg-blue-500/28 text-blue-300 border-blue-400/25"
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
                      <circle cx="11" cy="11" r="7" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <span>Search</span>
                  </button>
                  <button
                    onClick={handleFinalizePendingHighlight}
                    className={`px-2.5 py-1.5 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition-colors cursor-pointer ${
                      isLight
                        ? "bg-amber-500/15 hover:bg-amber-500/25 text-amber-800 border-amber-600/25"
                        : "bg-amber-500/18 hover:bg-amber-500/28 text-amber-300 border-amber-400/25"
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
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                    <span>Highlight</span>
                  </button>
                  <button
                    onClick={closeContextUI}
                    aria-label="Cancel selection"
                    className={`p-1.5 rounded-xl text-xs transition-colors cursor-pointer ${
                      isLight
                        ? "hover:bg-stone-900/[0.08] text-stone-500"
                        : "hover:bg-white/[0.1] text-zinc-400"
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
                </>
              )}
            </div>
          )}

        {/* PERSISTENT FOOTER */}
        {!showHeaderFooter && !showSidebar && (
          <div
            className={`h-6 w-full shrink-0 flex items-center justify-between px-4 text-[10px] uppercase tracking-widest font-semibold relative z-10 ${
              isLight
                ? "bg-[#fbf5e6] text-stone-500"
                : "bg-[#1c1c1c] text-zinc-500"
            }`}
          >
            <div className="flex-1">{pageInfo}</div>
            <div className="flex-1 text-center truncate px-2">
              {currentChapter}
            </div>
            <div className="flex-1 text-right">{currentPercentage}%</div>
          </div>
        )}

        {/* FOOTER CONTROLS */}
        {showHeaderFooter && (
          <div
            className={`px-3 py-2 flex items-center justify-between border-t backdrop-blur-md relative z-10 ${
              isLight
                ? "bg-[#f4ecd8]/92 text-stone-800 border-stone-900/10"
                : "bg-[#18181c]/92 text-zinc-100 border-white/[0.08]"
            }`}
          >
            {/* Left Side: Typography & Reader Theme */}
            <div className="relative w-1/3">
              <button
                onClick={() => setShowFontMenu(!showFontMenu)}
                className={`rounded-xl font-semibold text-sm py-2 px-3 flex items-center justify-center border transition-colors cursor-pointer ${
                  isLight
                    ? "bg-stone-900/[0.05] hover:bg-stone-900/[0.1] border-stone-900/10 text-stone-800"
                    : "bg-white/[0.07] hover:bg-white/[0.14] border-white/10 text-zinc-100"
                }`}
              >
                Aa
              </button>

              {showFontMenu && (
                <div
                  className={`absolute bottom-full left-0 mb-3 p-3 rounded-2xl shadow-2xl border backdrop-blur-xl flex flex-col gap-2.5 min-w-[160px] ${
                    isLight
                      ? "bg-[#fdfaf3]/95 text-stone-800 border-stone-900/10"
                      : "bg-[#18181c]/95 text-zinc-100 border-white/10"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => {
                        setFontSize((f) => Math.max(50, f - 10));
                        touchSettingsMeta("fontSize");
                      }}
                      className={`w-8 h-8 rounded-xl font-semibold text-lg flex items-center justify-center border transition-colors cursor-pointer ${
                        isLight
                          ? "bg-stone-900/[0.05] hover:bg-stone-900/[0.1] border-stone-900/10"
                          : "bg-white/[0.07] hover:bg-white/[0.14] border-white/10"
                      }`}
                    >
                      −
                    </button>
                    <span className="w-12 text-center text-xs font-semibold">
                      {fontSize}%
                    </span>
                    <button
                      onClick={() => {
                        setFontSize((f) => Math.min(300, f + 10));
                        touchSettingsMeta("fontSize");
                      }}
                      className={`w-8 h-8 rounded-xl font-semibold text-lg flex items-center justify-center border transition-colors cursor-pointer ${
                        isLight
                          ? "bg-stone-900/[0.05] hover:bg-stone-900/[0.1] border-stone-900/10"
                          : "bg-white/[0.07] hover:bg-white/[0.14] border-white/10"
                      }`}
                    >
                      +
                    </button>
                  </div>

                  <div
                    className={`border-t ${
                      isLight ? "border-stone-900/10" : "border-white/10"
                    }`}
                  />

                  <button
                    onClick={toggleTheme}
                    className={`w-full py-2 px-3 rounded-xl text-xs font-medium border transition-colors whitespace-nowrap cursor-pointer ${
                      isLight
                        ? "bg-stone-900/[0.05] hover:bg-stone-900/[0.1] border-stone-900/10"
                        : "bg-white/[0.07] hover:bg-white/[0.14] border-white/10"
                    }`}
                  >
                    {theme === "dark" ? "Light mode" : "Dark mode"}
                  </button>
                </div>
              )}
            </div>

            {/* Center Side: Navigation and Page Info */}
            <div className="flex items-center gap-3 sm:gap-5">
              <button
                onClick={() => rendition?.prev()}
                aria-label="Previous page"
                className={`flex items-center justify-center rounded-xl p-2 border transition-colors cursor-pointer ${
                  isLight
                    ? "bg-stone-900/[0.05] hover:bg-stone-900/[0.1] active:bg-stone-900/20 border-stone-900/10"
                    : "bg-white/[0.07] hover:bg-white/[0.14] active:bg-white/25 border-white/10"
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
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>

              <div
                className={`text-center text-[11px] uppercase whitespace-nowrap font-semibold tracking-wider ${
                  isLight ? "text-stone-600" : "text-zinc-400"
                }`}
              >
                {pageInfo}
              </div>

              <button
                onClick={() => rendition?.next()}
                aria-label="Next page"
                className={`flex items-center justify-center rounded-xl p-2 border transition-colors cursor-pointer ${
                  isLight
                    ? "bg-stone-900/[0.05] hover:bg-stone-900/[0.1] active:bg-stone-900/20 border-stone-900/10"
                    : "bg-white/[0.07] hover:bg-white/[0.14] active:bg-white/25 border-white/10"
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
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>

            {/* Right Side: Search */}
            <div className="w-1/3 flex justify-end">
              <button
                onClick={handleSearchSelection}
                aria-label="Search book"
                className={`rounded-xl p-2.5 border transition-colors cursor-pointer ${
                  isLight
                    ? "bg-blue-600/12 hover:bg-blue-600/20 text-blue-700 border-blue-600/20"
                    : "bg-blue-500/18 hover:bg-blue-500/28 text-blue-300 border-blue-400/25"
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
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}