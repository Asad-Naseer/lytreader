import type {Book} from '../App'
import {useRef, useState, useEffect} from 'react'
import ePub from 'epubjs';
import localforage from 'localforage';

interface readerProps {
    bookData: Book,
    onClose: () => void
}

interface tocItem {
    id: string,
    href: string,
    label: string,
    subitems?: tocItem[]
}

interface highlightItem {
    cfi: string;
    text: string;
    chapter?: string;
    percentage?: number;
}

interface SearchResult {
    cfi: string;
    excerpt: string;
    chapter: string;
    percentage?: number;
}

export default function Reader({bookData, onClose}: readerProps) {

    // Global book search states
    const[showSearch, setShowSearch] = useState<boolean>(false);
    const [searchQuery, setSearchQuery] = useState<string>("");
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const[isSearching, setIsSearching] = useState<boolean>(false);
    const searchIdRef = useRef<number>(0);

    // define a ref html div element to pass to epubjs so it can render the book into it
    const viewerRef = useRef<HTMLDivElement>(null); // this is just a plain div element. <div><div/>

    // define a promise ref for generation of locations 
    const locationsPromiseRef = useRef<Promise<any> | null>(null);

    // define pending highlight var to check for when highlights start and deciding when to finalize them
    const pendingHighlight = useRef<{cfi: string, contents: any} | null>(null)

    // define selection text for dictionary lookup
    const [selectionText, setSelectionText] = useState<string>("");

    // define bookHighlightsKey for loading book highlights
    const bookHighlightsKey = `highlights-${bookData.id}`;

    // define list state for highlights
    const [highlightsList, setHighlightsList] = useState<highlightItem[]>([]);
    // define state for searching the highlights
    const [highlightsSearch, setHighlightsSearch] = useState<string>("");

    // define deleteMenu state for deleting highlights. this will use x,y values to determine where it should appear.
    const [deleteMenu, setDeleteMenu] = useState<{cfi: string} | null>(null)

    // define rendition and pageInfo states for epubjs and book state
    const [book, setBook] = useState<any>(null);
    const [rendition, setRendition] = useState<any>(null)
    const [pageInfo, setPageInfo] = useState<string>("Calculating")

    // define states for the persisten footer 
    const [currentChapter, setCurrentChapter] = useState<string>("Unknown Chapter");
    const [currentPercentage, setCurrentPercentage] = useState<number>(0);

    // define a state to control the visibility of the header
    const [showHeaderFooter, setShowHeaderFooter] = useState<boolean>(false);

    // Sidebar and TOC states
    const [showSidebar, setShowSidebar] = useState<boolean>(false);
    const [sidebarTab, setSidebarTab] = useState<'toc' | 'highlights' | 'photos'>('toc');
    // states for handling photos in sidebarTab
    const [photosList, setPhotosList] = useState<string[]>([]);
    const [photosLoading, setPhotosLoading] = useState<boolean>(false);
    // we will use this for preventing memory leaks. (see loadPhotos function in fetch photos useEffect())
    const photoBlobUrlsRef = useRef<string[]>([]);
    // state for handling toc
    const [toc, setToc] = useState<tocItem[]>([]);

    // Fontsize states
    const [fontSize, setFontSize] = useState<number>(100) // percentage
    const [showFontMenu, setShowFontMenu] = useState<boolean>(false);

    // 1. Load saved font size on initial mount 
    useEffect(() => {
        const loadSavedSettings = async () => {
            const savedFontSize = await localforage.getItem<number>('reader-font-size');
            if (savedFontSize) {
                setFontSize(savedFontSize);
                console.log("saved font size applied", savedFontSize)
            }
        };
        loadSavedSettings();
    }, []);

    // Use useEffect to make sure book is loaded then check if both viewerRef and bookData.data are present.
    // Setup new rendition, generate page locations and update state whenever rendition is "relocated" (page changes)

    useEffect(() => {

        if(!viewerRef.current || !bookData.data) return; // stop execution if either are false/missing

        // initialize book using the data and epubjs and create and display rendition
        const newBook = ePub(bookData.data);
        setBook(newBook);
        const newRendition = newBook.renderTo(viewerRef.current, {
            width: "100%",
            height: "100%",
            flow: "scrolled",
        }as any)


        // disable chrome opening context menu on every click;
        newRendition.hooks.content.register((contents: any) => {
            const doc = contents.document;
            const body = doc.body;

            if (body) {
                // Setting tabindex to -1 tricks Chrome into thinking the body is an interactive 
                // element, which completely disables the "Touch to Search" / Google Search popup.
                body.setAttribute('tabindex', '-1');
            }

            // Prevent the default OS context menu (copy/paste/share) from appearing on long press
            doc.addEventListener('contextmenu', (e: Event) => {
                e.preventDefault();
            });
        });

        // Inject CSS into the epub iframe to prevent text selection and touch callouts. Otherwise text will get selected whenever user clicks to change page on a touch screen.
        newRendition.themes.default({
            "body": {
                // "-webkit-user-select": "none",
                // "user-select": "none",
                "-webkit-touch-callout": "none", // Disables the iOS/Android popup menu
                "color": "#c2c2c2",
                "max-width": "1000px !important",
                "margin": "0 auto !important",
                // "padding": "0px !important"
            },
            "::selection": {
                "background": "rgba(255, 255, 0, 0.3)"
            },
            ".epubjs-hl": {
                "fill": "yellow",
                "fill-opacity": "0.3",
                // "mix-blend-mode": "multiply"
            }
        });


        


        // Get TOC from epubjs
        newBook.loaded.navigation.then((nav:any) => {
            setToc(nav.toc);
        });

        // actually display the rendition and check for stored book positions
        const loadSavedPositions = async () => {
            const savedCfi = await localforage.getItem<string>(`progress-${bookData.id}`);
            if (savedCfi) {
                await newRendition.display(savedCfi);
                await newRendition.display(savedCfi);
                console.log("Saved cfi displayed,", savedCfi)
            } else {
                newRendition.display();
            }
        }

        loadSavedPositions();
        

        // now calculate and update pageInfo state (page numbers)

        newBook.ready.then(() => {
            // save location generation in a promise so we can await it later (this is for correct percentage generation for the highlights, see finalizeHighlight function)
            locationsPromiseRef.current = newBook.locations.generate(100);
            return locationsPromiseRef.current; // 100 characters define a location chunk, which epub.js uses to approximate pages.
        }).then((_locations: any) => {
            const currentLocation = newRendition.currentLocation() as any; // this will be used only once to show the locations

            if (currentLocation) {
                setPageInfo(`${currentLocation.start.displayed.page} / ${currentLocation.start.displayed.total}`);
            }
        });

        // setup state updates for whenver user turns a page (rendition relocates)
        newRendition.on("relocated", async (location:any) => {

            // Save position to browser indexedDB via localforage
            localforage.setItem(`progress-${bookData.id}`, location.start.cfi);
            console.log("cfi saved", location.start.cfi)

            if (location.start.displayed.total) {               // check if epubjs has already calculated total pages
                setPageInfo(`${location.start.displayed.page} / ${location.start.displayed.total}`);
            }

            // 1. Get Current Chapter (Loads instantly)
            let chapter = "Unknown Chapter";
            try {
                const spineItem = newBook.spine.get(location.start.cfi);
                if (spineItem) {
                    const nav = await newBook.loaded.navigation;
                    const bookToc = nav.toc;
                    
                    const searchToc = (items: tocItem[], href: string): string | null => {
                        for (const item of items) {
                            if (item.href === href || item.href.split('#')[0] === href) return item.label;
                            if (item.subitems && item.subitems.length > 0) {
                                const found = searchToc(item.subitems, href);
                                if (found) return found;
                            }
                        }
                        return null;
                    };
                    
                    const foundTitle = searchToc(bookToc, spineItem.href);
                    if (foundTitle) chapter = foundTitle.trim();
                }
            } catch (error) {
                console.error("Error fetching current chapter:", error);
            }
            setCurrentChapter(chapter);

            // 2. Get Current Percentage (Waits for generation if needed)
            let percent = 0;
            try {
                if (locationsPromiseRef.current) {
                    await locationsPromiseRef.current; // wait if it's still generating
                }
                if (newBook.locations && newBook.locations.length() > 0) {
                    const percentCfi = newBook.locations.percentageFromCfi(location.start.cfi);
                    if (percentCfi > 0) {
                        percent = Math.round(percentCfi * 100);
                    }
                }
            } catch (err) {
                console.error("Error waiting for locations to generate:", err);
            }
            setCurrentPercentage(percent);
        })

        // finally set the rendition state
        setRendition(newRendition);

        // run cleaup func to destroy the book when component unmounts
        return () => {
            newBook.destroy();
        };


    }, [bookData]);


    // Apply and Save Fontsize whenever it changes
    useEffect(() => {
        if (rendition) {
            rendition.themes.fontSize(`${fontSize}%`);
            // Save globally to persist accross book reloads
            localforage.setItem('reader-font-size', fontSize);
            console.log("Font size applied", fontSize)
        }
    }, [fontSize, rendition]);


    // SETTING UP NAVIGATION USING keyboard, clicks and swipes
    // use useEffect to check if rendition state is live before setting up navigation controls.

    useEffect(() => {
        if (!rendition) return; // stop execution if rendition is null or falsy

        // 1. setup Spacebar and Shift + spacebar to go forward or backward.
        const handleKeyDown = (e: KeyboardEvent) => {

            const target = e.target as HTMLElement;
        if (
            target.tagName === 'INPUT' || 
            target.tagName === 'TEXTAREA' || 
            target.isContentEditable
        ) {
            return; // Exit the function and do nothing if the user is typing
            }


            if (e.code === "Space") {
                if (e.shiftKey) {
                    rendition.prev();
                } else rendition.next();
            }
        };

        // 2. Handle clicks (left, right, or middle of the screen)
        
        // here we have to do some magic with modulo operator to calculate the correct X co-ordinate where the user clicked relative to
        //width of the screen
        
        /* this is because epubjs basically creates a long horizontal sheet of the content of the epub. This can cause problems.
         If the viewer width is 800px, on page one, a click to the left 30% of the screen would register correctly. 
         But if we are on the second page now the total width goes from 800px at the left to 1600px when we reach the end of the page.
         even if the user clicks on the left 30% of the viwer it would still count as being a click on the right side and the page would
         only go forward. For this reason we need to calculate the modulo of the click co-ordinate relative to the viewer width. */

        const handleClick = (e: any) => {

            // if a pending highlight is detected, finalize it immediately.
            if (pendingHighlight.current) {
                setShowHeaderFooter(true);
                return;
            }

            // disappear delete and font menu when user clicks somewhere that is not the delete button
            setDeleteMenu(null);
            setShowFontMenu(false);

            // get the width of the viewer
            const viewerWidth = viewerRef.current ? viewerRef.current.clientWidth : window.innerWidth;

            const clickX = e.clientX % viewerWidth;
            
            if (clickX < viewerWidth * 0.01) {
                rendition.prev();
            } else if (clickX > viewerWidth * 0.99) {
                rendition.next();
            } else {
                setShowHeaderFooter((prev) => !prev);  // set showHeader to flase if true and true if flase
            }
        }

        // 3. Swipe logic for phones and touch screens
        
        // declare touchStartX and touchEndX variables
        let touchStartX = 0;
        let touchEndX = 0;

        // create handTouchStart and handleTouchEnd logics which will be passed to rendition appropriately.

        const handleTouchStart = (e: any) => {
            touchStartX = e.changedTouches[0].screenX;
        };

        const handleTouchEnd = (e: any) => {
            touchEndX = e.changedTouches[0].screenX;

            const swipeDistance = touchStartX - touchEndX;
            if (swipeDistance > 200) { 
                rendition.next(); // user swiped from right to left
            } else if (swipeDistance < -200) {
                rendition.prev(); // user swiped from left to right
            }
        };

        // listen in on the document for the keyboard keys
        document.addEventListener('keydown', handleKeyDown);

        // listen in on the rendition for everything
        rendition.on('keydown', handleKeyDown);
        rendition.on('click', handleClick);
        rendition.on('touchstart', handleTouchStart);
        rendition.on('touchend', handleTouchEnd);

        // Setup cleanup func to destroy event listeners when component unmounts
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            rendition.off('keydown', handleKeyDown);
            rendition.off('click', handleClick);
            rendition.off('touchstart', handleTouchStart);
            rendition.off('touchend', handleTouchEnd);

        }

    }, [rendition]);

    
    // make finalizeHighlight function to call automatically after 5 seconds of inactivity after highlighting something
    const finalizeHighlight = async (cfiRange: string, contents:any) => {

        if(!rendition || !book || !pendingHighlight.current) return;

        // only proceed if the highlight has not been finalized yet.
        if (!pendingHighlight.current) return;
        
        // clear the pendinghighlight (we already have the cfi and contents from it)
        pendingHighlight.current = null;

        // apply to ui , remove first to make sure no duplicates
        rendition.annotations.remove(cfiRange, "highlight");
        rendition.annotations.add('highlight', cfiRange, {}, (e: MouseEvent) => {
            setDeleteMenu({cfi: cfiRange});
            console.log("Clicked Highlight:", cfiRange, e, contents)
        })


        

        // get the text
        const range = await book.getRange(cfiRange);
        const text = range.toString();

        // calc the percentage

        // 1. Calculate the Percentage
        let percentage = 0;
        try {
            // If the background page generation is still running, wait for it to finish
            if (locationsPromiseRef.current) {
                await locationsPromiseRef.current;
            }

            // Now that we are 100% sure locations are generated, calculate it
            if (book.locations && book.locations.length() > 0) {
                const percentCfi = book.locations.percentageFromCfi(cfiRange);
                if (percentCfi > 0) {
                    percentage = Math.round(percentCfi * 100);
                }
            }
        } catch (err) {
            console.error("Error waiting for locations to generate:", err);
        }

        // 2. Calculate the Chapter Title
        let chapter = "Unknown Chapter";
        try {
            const spineItem = book.spine.get(cfiRange);
            if (spineItem) {
                // helper function to search through the TOC
                const searchToc = (items: tocItem[], href: string): string | null => {
                    for (const item of items) {
                        // Match exact href or just the file path without HTML anchors (#)
                        if (item.href === href || item.href.split('#')[0] === href) return item.label;
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


        const existingHighlights: highlightItem[] = await localforage.getItem(bookHighlightsKey) || [];

        if (!existingHighlights.find(h => h.cfi === cfiRange)) {
            existingHighlights.push({ cfi: cfiRange, text: text, chapter, percentage });
            await localforage.setItem(bookHighlightsKey, existingHighlights);
        }


    }


    // Applying and saving highlights.
    useEffect(() => {
        if (!rendition || !book) return;
        const handleSelected = (cfiRange: string, contents: any) => {
            const range = rendition.getRange(cfiRange);
            const text = range.toString().trim();

            // mark the cfi and contents passed to handleSelected as pending highlight & give the text to selectionText
            pendingHighlight.current = {cfi: cfiRange, contents}
            setSelectionText(text);

        };

        rendition.on("selected", handleSelected);

        // cleanup when component dismounts
        return () => {
            rendition.off("selected", handleSelected);
        };
    }, [rendition, book])

    

    // Apply saved highlights
    useEffect(() => {

        if (!rendition) return;

        const applySavedHighlights = async () => {
            
            // get array of CFIs and Texts from storage
            const savedHighlights: highlightItem[] = await localforage.getItem(bookHighlightsKey) || [];

            // loop through the highlights and apply them
            savedHighlights.forEach(hl => {

                // remove it if it already exists because render keeps drawing it again whever the chapter loads, this only removes the visual highlight
                rendition.annotations.remove(hl.cfi, 'highlight');

                rendition.annotations.add('highlight', hl.cfi, {}, (e:MouseEvent) => {

                    // give deleteMenu state the x and y position of where user clicked and the cfi to delete.
                    setDeleteMenu({
                        cfi: hl.cfi
                    });

                    console.log("clicked highlight: ", hl.cfi, e)
                });
            });

            console.log(`Applied ${savedHighlights.length} highlights`);
        }

        rendition.on('rendered', applySavedHighlights);

        // clean up 

        return () => {
            rendition.off('rendered', applySavedHighlights);
        };


    }, [rendition, bookData.id])
    
    
    // function for removing highlights
    const handleRemoveHighlight = async (cfi: string) => {
        if (!rendition) return;
        
        // remove highlight from ui
        rendition.annotations.remove(cfi, 'highlight');

        // remove from localforage 
        const existingHighlights: highlightItem[] = await localforage.getItem(bookHighlightsKey) || [];
        const updatedHighlights = existingHighlights.filter(h => h.cfi !== cfi);
        await localforage.setItem(bookHighlightsKey, updatedHighlights);

        // close the menu
        setDeleteMenu(null);
    }



    // fetch highlights data whenever sidebar opens
    useEffect(() => {
        if (showSidebar && sidebarTab === 'highlights') {
            const load = async () => {
                const data = await localforage.getItem<highlightItem[]>(bookHighlightsKey);

                if (data) {
                    //sort descending compare b to a 
                    // numeric true handles numbers inside strings better
                    const sortedData = [...data].sort((a,b) => 
                        b.cfi.localeCompare(a.cfi, undefined, {numeric: true, sensitivity: 'base'})
                    );
                    setHighlightsList(sortedData);
                } else {
                    setHighlightsList([]);
                }
            }
            load();
        }
    }, [showSidebar, sidebarTab, bookHighlightsKey])

    
// Fetch photos from the epub whenever the Photos tab is opened.
    useEffect(() => {
        if (!showSidebar || sidebarTab !== 'photos' || !book) return;

        setPhotosList([]);
        setPhotosLoading(true);

        let cancelled = false; // guard against stale async runs (StrictMode / fast tab switches)

        const loadPhotos = async () => {
            try {
                await book.ready;

                const manifest = book.packaging.manifest;

                const imageItems = (Object.values(manifest) as any[])
                    .filter(item => typeof item.type === 'string' && item.type.startsWith('image/'))
                    .sort((a, b) => a.href.localeCompare(b.href, undefined, { numeric: true, sensitivity: 'base' }));

                console.log(`[Photos] ${imageItems.length} images sorted by href`);

                const urls: string[] = [];

                for (const item of imageItems as any[]) {
                    if (cancelled) break;

                    let url: string | null = null;

                    // Strategy 1: archive.createUrl with resolved (zip-root) path
                    try {
                        const resolvedHref = book.path.resolve(item.href);
                        if (book.archive && typeof book.archive.createUrl === 'function') {
                            url = await book.archive.createUrl(resolvedHref, { base64: false });
                        }
                    } catch (e) {
                        console.warn("[Photos] archive.createUrl failed for", item.href, e);
                    }

                    // Strategy 2: book.load() resolves paths internally, returns a Blob
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
            cancelled = true; // discard results if effect re-fires before async finishes
            photoBlobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
            photoBlobUrlsRef.current = [];
        };
    }, [showSidebar, sidebarTab, book]);



    // define filtered highlights from highlightsList by using highlightsSearch
    const filteredHighlights = highlightsList.filter((hl) => {
        return hl.text.toLowerCase().includes(highlightsSearch.toLowerCase())
    });

    // Render Highlights function
    const renderHighlights = () => {
        if (filteredHighlights.length === 0) {                              // by default it won't be zero because "" just means get everything into filteredHighlights
            return <p className="p-4 text-center text-gray-500">
                {highlightsSearch ? "No Matching Highlights found" : "No Highlights Yet"}
            </p>;
        }

        return filteredHighlights.map((item, index) => {
            return (
                <button
            key={item.cfi || index}
            className='text-left w-full py-3 px-4 border-b'
            onClick={ async () => {
                await rendition.display(item.cfi);
                await rendition.display(item.cfi); // double for hack, to display the proper position.
                setShowSidebar(false);
            }}
            >

                {/* Chapter and Percentage Header */}
                    <div className="w-full flex justify-between items-start text-[10px] text-gray-400 uppercase tracking-widest font-semibold mb-1">
                        <span className="truncate pr-2">
                            {item.chapter || "Unknown Chapter"}
                        </span>
                        <span>
                            {item.percentage !== undefined ? `${item.percentage}%` : ""}
                        </span>
                    </div>

                    <p className="text-sm italic leading-relaxed">
                        "{item.text}"
                    </p>
                
            </button>
            )
        })
    }


    // Render TOC function
    const renderToc = (items: tocItem[], level = 0) => {
        return items.map((item, index) => (
            <div key={item.id || index}>
                <button
                    className="text-left w-full py-3 px-4 border-b"
                    style={{ paddingLeft: `${(level * 1.5) + 1}rem` }} // if level is non zero meaning subitems are being rendered, this will add some padding to them
                    onClick={() => {
                        rendition.display(item.href);
                        setShowSidebar(false);
                        setShowHeaderFooter(false);
                    }}
                >
                    {item.label}
                </button>
                {item.subitems && item.subitems.length > 0 && renderToc(item.subitems, level + 1)}
            </div>
        ));
    };


    // func for opening a Google search in a new tab 
    const handleDictionaryLookup = () => {
        if (!selectionText) return;

        // selects the first word and removes the punctuation from it
        const word = selectionText.split(/\s+/)[0].replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,""); 
        
        // create the google search url
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(word + ' meaning')}`;
        
        // open in a new tab securely
        window.open(searchUrl, '_blank', 'noopener,noreferrer');

        // close the selection menu
        closeContextUI();
    };


    // func for closing context ui gracefully
    const closeContextUI = () => {
        pendingHighlight.current = null;
        setSelectionText("");
        setShowHeaderFooter(false);
    }


    // func for searching entire book
    // Search the entire book (streams results as it goes)
    const executeSearch = async (query: string) => {
        if (!book || !query.trim()) return;
        
        // Increment the search ID. This allows us to cancel this loop if the user types another letter.
        const currentSearchId = ++searchIdRef.current;
        
        setIsSearching(true);
        setSearchResults([]);

        try {
            if (locationsPromiseRef.current) {
                await locationsPromiseRef.current;
            }

            const results: SearchResult[] =[];
            const spineItems = book.spine.spineItems;

            for (let i = 0; i < spineItems.length; i++) {
                // If the user typed something else, the ID will have changed. Abort this search.
                if (currentSearchId !== searchIdRef.current) return;

                const item = spineItems[i];
                await item.load(book.load.bind(book));
                const matches = item.find(query);
                item.unload();

                if (matches && matches.length > 0) {
                    const searchToc = (items: tocItem[], targetHref: string): string | null => {
                        for (const t of items) {
                            if (t.href === targetHref || t.href.split('#')[0] === targetHref) return t.label;
                            if (t.subitems && t.subitems.length > 0) {
                                const found = searchToc(t.subitems, targetHref);
                                if (found) return found;
                            }
                        }
                        return null;
                    };

                    let chapterName = searchToc(toc, item.href) || "Unknown Chapter";

                    for (const match of matches) {
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
                            percentage
                        });
                    }
                    
                    // Stream results to the UI instantly!
                    if (currentSearchId === searchIdRef.current) {
                        setSearchResults([...results]);
                    }
                }
            }

            // Mark as done when the loop completely finishes
            if (currentSearchId === searchIdRef.current) {
                setIsSearching(false);
            }

        } catch (error) {
            console.error("Search failed:", error);
            if (currentSearchId === searchIdRef.current) setIsSearching(false);
        }
    };

    // Auto-trigger search when user types (with 500ms debounce)
    useEffect(() => {
        // If the query is cleared, reset everything and kill active searches
        if (!searchQuery.trim()) {
            searchIdRef.current++; // <--- THIS ABORTS THE BACKGROUND LOOP
            setSearchResults([]);
            setIsSearching(false);
            return;
        }

        // Wait 500ms before executing the search to prevent freezing while typing
        const delayFn = setTimeout(() => {
            executeSearch(searchQuery);
        }, 500);

        // Cleanup timeout if user types again before 500ms is up
        return () => clearTimeout(delayFn);
    }, [searchQuery]);


    // Safely escape regex characters to prevent crashes, and ignore empty queries
    const highlightQuery = searchQuery.trim();
    const safeRegex = highlightQuery ? new RegExp(`(${highlightQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi') : null;



    // WHAT THE READER ACTUALLY RENDERS:

    return (
    <>
        <div className='flex flex-col absolute w-full h-full top-0 overflow-hidden'>
            {/* TOP BAR */}
            {showHeaderFooter && (
                <div className='absolute bg-[#1c1c1c] top-0 left-0 w-full z-10 flex justify-between items-center p-3 shadow-md'>
                    <div className="flex">
                        {!pendingHighlight.current ? (
                            <button
                                onClick={() => { setShowSidebar(true); setShowHeaderFooter(false); }}
                                className='rounded py-2 px-3 hover:bg-white/5'>
                                ☰ Menu
                            </button>
                        ) : (
                            <div className="flex gap-2">
                                <button
                                    onClick={handleDictionaryLookup}
                                    className="bg-blue-700 hover:bg-blue-500 px-4 py-2 rounded text-sm flex items-center gap-2">
                                    <span>🔎</span>
                                </button>
                                <button
                                    onClick={() => {
                                        const { cfi, contents } = pendingHighlight.current!;
                                        finalizeHighlight(cfi, contents);
                                        closeContextUI();
                                    }}
                                    className="bg-yellow-700 hover:bg-yellow-500 px-4 py-2 rounded text-sm font-medium">
                                    ✏️
                                </button>
                                <button
                                    onClick={closeContextUI}
                                    className="px-4 py-2 text-sm rounded bg-[#e24741]">
                                    Cancel
                                </button>
                            </div>
                        )}
                    </div>

                    {deleteMenu && (
                        <button
                            onClick={() => handleRemoveHighlight(deleteMenu.cfi)}
                            className='bg-[#e24741] hover:bg-red-700 py-1.5 px-3 rounded transition-colors text-sm'
                        >
                            Delete Highlight
                        </button>
                    )}

                    <button
                        onClick={onClose}
                        className='bg-[#e24741] hover:bg-red-600 rounded px-4 py-2 pointer transition-colors font-medium'>
                        Close
                    </button>
                </div>
            )}

            {/* SEARCH OVERLAY CARD */}
            {showSearch && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
                    <div className="bg-[#1c1c1c] w-full max-w-lg h-[80%] max-h-[700px] rounded-lg shadow-2xl border border-white/10 flex flex-col overflow-hidden">
                        
                        {/* Search Card Header */}
                        <div className="flex items-center justify-between p-4 border-b border-white/10 bg-black/20">
                            <h2 className="font-semibold text-white tracking-wide">Search Book</h2>
                            <button 
                                onClick={() => setShowSearch(false)} 
                                className="text-gray-400 hover:text-white px-2 rounded hover:bg-white/10 transition-colors">
                                ✕
                            </button>
                        </div>

                        {/* Search Input Area */}
                        <div className="p-4 border-b border-white/10 bg-white/5">
                            <input
                                type="text"
                                placeholder="Start typing to search..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full bg-[#121212] border border-white/20 rounded-md px-4 py-2 text-sm focus:outline-none focus:border-blue-500 transition-colors text-white placeholder-gray-500"
                            />
                        </div>

                        {/* Search Results Area */}
                        <div className="flex-1 overflow-y-auto p-2 bg-[#1c1c1c]">
                            {searchResults.length > 0 ? (
                                <div className="space-y-1">
                                    {searchResults.map((res, i) => (
                                        <button
                                            key={i}
                                            onClick={async () => {
                                                await rendition.display(res.cfi);
                                                await rendition.display(res.cfi); // Double execution hack
                                                setShowSearch(false);
                                            }}
                                            className="w-full text-left p-4 hover:bg-white/5 rounded-lg border-b border-white/5 transition-colors focus:bg-white/10 focus:outline-none"
                                        >
                                            <div className="flex justify-between items-start text-[10px] text-gray-400 uppercase tracking-widest font-semibold mb-2">
                                                <span className="truncate pr-2">{res.chapter}</span>
                                                <span className="shrink-0">{res.percentage}%</span>
                                            </div>
                                            
                                            <p className="text-sm text-gray-300 italic leading-relaxed">
                                                {safeRegex ? (
                                                    (res.excerpt || "").split(safeRegex).map((part, index) => 
                                                        part.toLowerCase() === highlightQuery.toLowerCase() ? (
                                                            <mark key={index} className="bg-yellow-500/40 text-white rounded px-1">{part}</mark>
                                                        ) : (
                                                            part
                                                        )
                                                    )
                                                ) : (
                                                    res.excerpt
                                                )}
                                            </p>
                                        </button>
                                    ))}
                                    
                                    {/* Show a mini loading indicator at the bottom if it's still scanning remaining chapters */}
                                    {isSearching && (
                                        <div className="text-center text-gray-500 py-4 text-xs uppercase tracking-widest animate-pulse font-semibold">
                                            Scanning remaining chapters...
                                        </div>
                                    )}
                                </div>
                            ) : isSearching ? (
                                <div className="flex flex-col items-center justify-center h-full text-gray-400">
                                    <div className="animate-spin text-2xl mb-4">⏳</div>
                                    <p className="text-sm">Scanning entire book...</p>
                                </div>
                            ) : searchQuery ? (
                                <p className="text-center text-gray-500 mt-10 text-sm">No results found for "{searchQuery}".</p>
                            ) : (
                                <p className="text-center text-gray-500 mt-10 text-sm">Type a keyword to begin searching.</p>
                            )}
                        </div>
                    </div>
                </div>
            )}





            {/* SIDEBAR OVERLAY */}
            {showSidebar && (
                <div className="absolute inset-0 z-20 flex">
                    <div className="w-4/5 max-w-sm h-full bg-[#1c1c1c] flex flex-col">
                        <div className="flex border-b text-center">
                            <button
                                className={`flex-1 py-4 font-semibold ${sidebarTab === 'toc' ? 'border-b-4' : 'text-gray-500'}`}
                                onClick={() => setSidebarTab('toc')}
                            >
                                Chapters
                            </button>
                            <button
                                className={`flex-1 py-4 font-semibold ${sidebarTab === 'highlights' ? 'border-b-4' : 'text-gray-500'}`}
                                onClick={() => setSidebarTab('highlights')}
                            >
                                Highlights
                            </button>
                            <button
                                className={`flex-1 py-4 font-semibold ${sidebarTab === 'photos' ? 'border-b-4' : 'text-gray-500'}`}
                                onClick={() => setSidebarTab('photos')}
                            >
                                Photos
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto">
                            {sidebarTab === 'toc' && (
                                <div className="flex flex-col">
                                    {toc.length > 0 ? renderToc(toc) : <p className="p-4">No Table of Contents found.</p>}
                                </div>
                            )}
                            {sidebarTab === 'highlights' && (
                                <div className="flex flex-col h-full overflow-hidden">
                                    {/* Scrollable Area */}
                                    <div className="flex-1 overflow-y-auto">
                                        {renderHighlights()}
                                    </div>

                                    {/* Search Bar at the bottom */}
                                    <div className="p-3 border-t border-white/10 bg-[#1c1c1c]">
                                        <div className="relative">
                                            <input
                                                type="text"
                                                placeholder="Search highlights..."
                                                value={highlightsSearch}
                                                onChange={(e) => setHighlightsSearch(e.target.value)}
                                                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-blue-500 transition-colors"
                                            />
                                            {highlightsSearch && (
                                                <button 
                                                    onClick={() => setHighlightsSearch("")}
                                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                                                >
                                                    ✕
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                            {sidebarTab === 'photos' && (
                                <>
                                    {photosLoading ? (
                                        <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
                                            Loading images...
                                        </div>
                                    ) : photosList.length === 0 ? (
                                        <p className="p-4 text-center text-gray-500 text-sm">
                                            No images found in this book.
                                        </p>
                                    ) : (
                                        <>
                                            <p className="text-[10px] text-white/30 uppercase tracking-widest font-semibold text-center py-2 border-b border-white/10">
                                                {photosList.length} image{photosList.length !== 1 ? 's' : ''}
                                            </p>
                                            <div className="grid grid-cols gap-2 p-3">
                                                {photosList.map((url, index) => (
                                                    <button
                                                        key={index}
                                                        onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                                                        className="aspect-square rounded overflow-hidden bg-white/5 hover:ring-2 hover:ring-blue-500 transition-all"
                                                    >
                                                        <img
                                                            src={url}
                                                            alt={`Book image ${index + 1}`}
                                                            className="w-full h-full object-cover"
                                                            onError={(e) => {
                                                                // Hide the button if the image breaks
                                                                const btn = (e.target as HTMLImageElement).closest('button');
                                                                if (btn) btn.style.display = 'none';
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
                    </div>

                    <div
                        className="flex-1 bg-black/50"
                        onClick={() => setShowSidebar(false)}
                    ></div>
                </div>
            )}

            {/* THE VIEWER */}
            <div ref={viewerRef} className='flex-1 overflow-hidden relative z-0'></div>

            {/* PERSISTENT FOOTER */}
            {!showHeaderFooter && !showSidebar && (
                <div className="h-6 w-full shrink-0 flex items-center justify-between px-4 text-[10px] text-white/40 uppercase tracking-widest font-semibold bg-[#1c1c1c] relative z-10">
                    <div className="flex-1">{pageInfo}</div> {/* Empty space for left balance */}
                    
                    <div className="flex-1 text-center truncate px-2">
                        {currentChapter}
                    </div>
                    
                    <div className="flex-1 text-right">
                        {currentPercentage}%
                    </div>
                </div>
            )}

            {/* FOOTER */}
            {showHeaderFooter && (
                <div className='p-1 flex items-center justify-between border-t relative z-10 bg-[#1c1c1c]'>
                    <div className="relative w-1/3 pl-4">
                        <button
                            onClick={() => setShowFontMenu(!showFontMenu)}
                            className="ml-4 rounded font-bold px-4 py-2 flex items-center justify-center ">
                            Aa
                        </button>

                        {showFontMenu && (
                            <div className="absolute bottom-full left-0 mb-3 bg-[#1c1c1c] p-2 rounded shadow-lg border flex items-center gap-3">
                                <button
                                    onClick={() => setFontSize(f => Math.max(50, f - 10))}
                                    className="w-8 h-8 rounded font-bold text-xl flex items-center justify-center">
                                    -
                                </button>
                                <span className="w-12 text-center font-medium">{fontSize}%</span>
                                <button
                                    onClick={() => setFontSize(f => Math.min(300, f + 10))}
                                    className="w-8 h-8 rounded font-bold text-xl flex items-center justify-center">
                                    +
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Center Side: Navigation and Page Info */}
        <div className='flex items-center gap-6'>
            <button 
                onClick={() => rendition?.prev()}
                className="flex items-center justify-center rounded px-3 py-1 bg-white/20 active:bg-white/70"
            >
                ‹
            </button>
            
            <div className='text-center text-[11px] flex uppercase whitespace-nowrap text-gray-400 font-medium'>
                {pageInfo}
            </div>

            <button 
                onClick={() => rendition?.next()}
                className="flex items-center justify-center rounded px-3 py-1 bg-white/20 active:bg-white/70"
            >
                ›
            </button>
        </div>

        {/* Right Side: Spacer to keep center balanced */}
        <div className="w-1/3 flex justify-end">
            <button
            onClick={() => { setShowSearch(true); setShowHeaderFooter(false); }}
            className='rounded py-2 px-3 hover:bg-white/5'
            >
            Search 🔎
            </button>
        </div>
    </div>
            )}
        </div>
    </>
);


}