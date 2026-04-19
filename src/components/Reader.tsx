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

export default function Reader({bookData, onClose}: readerProps) {

    // define a ref html div element to pass to epubjs so it can render the book into it
    const viewerRef = useRef<HTMLDivElement>(null); // this is just a plain div element. <div><div/>

    // define pending highlight var to check for when highlights start and deciding when to finalize them
    const pendingHighlight = useRef<{cfi: string, contents: any} | null>(null)

    // define selection text for dictionary lookup
    const [selectionText, setSelectionText] = useState<string>("");

    // define bookHighlightsKey for loading book highlights
    const bookHighlightsKey = `highlights-${bookData.id}`;

    // define list state for highlights
    const [highlightsList, setHighlightsList] = useState<{cfi: string, text: string}[]>([]);
    // define state for searching the highlights
    const [highlightsSearch, setHighlightsSearch] = useState<string>("");

    // define deleteMenu state for deleting highlights. this will use x,y values to determine where it should appear.
    const [deleteMenu, setDeleteMenu] = useState<{cfi: string} | null>(null)

    // define rendition and pageInfo states for epubjs and book state
    const [book, setBook] = useState<any>(null);
    const [rendition, setRendition] = useState<any>(null)
    const [pageInfo, setPageInfo] = useState<string>("Calculating")

    // define a state to control the visibility of the header
    const [showHeaderFooter, setShowHeaderFooter] = useState<boolean>(false);

    // Sidebar and TOC states
    const [showSidebar, setShowSidebar] = useState<boolean>(false);
    const [sidebarTab, setSidebarTab] = useState<'toc' | 'highlights'>('toc');
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
                "max-width": "1200px !important",
                "margin": "0 auto !important"
                // "padding": "0px !important"
            },
            "::selection": {
                "background": "rgba(225,225,0,0.3)"
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
            return newBook.locations.generate(100); // 1024 characters define a location chunk, which epub.js uses to approximate pages.
        }).then((_locations: any) => {
            const currentLocation = newRendition.currentLocation() as any; // this will be used only once to show the locations

            if (currentLocation) {
                setPageInfo(`${currentLocation.start.displayed.page} / ${currentLocation.start.displayed.total}`);
            }
        });

        // setup state updates for whenver user turns a page (rendition relocates)
        newRendition.on("relocated", (location:any) => {

            // Save position to browser indexedDB via localforage
            localforage.setItem(`progress-${bookData.id}`, location.start.cfi);
            console.log("cfi saved", location.start.cfi)

            if (location.start.displayed.total) {               // check if epubjs has already calculated total pages
                setPageInfo(`${location.start.displayed.page} / ${location.start.displayed.total}`);
            }
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

        // save to localforage
        const range = await book.getRange(cfiRange);
        const text = range.toString();
        const existingHighlights: {cfi: string, text: string}[] = await localforage.getItem(bookHighlightsKey) || [];

        if (!existingHighlights.find(h => h.cfi === cfiRange)) {
            existingHighlights.push({ cfi: cfiRange, text: text });
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
            const savedHighlights: {cfi: string, text: string}[] = await localforage.getItem(bookHighlightsKey) || [];

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
        const existingHighlights: {cfi: string, text: string}[] = await localforage.getItem(bookHighlightsKey) || [];
        const updatedHighlights = existingHighlights.filter(h => h.cfi !== cfi);
        await localforage.setItem(bookHighlightsKey, updatedHighlights);

        // close the menu
        setDeleteMenu(null);
    }



    // fetch highlights data whenever sidebar opens
    useEffect(() => {
        if (showSidebar && sidebarTab === 'highlights') {
            const load = async () => {
                const data = await localforage.getItem<{cfi: string, text: string}[]>(bookHighlightsKey);

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


    // func for opening a Google search in a new tab [study this]
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

            {!showHeaderFooter && !showSidebar && (
                <div className="absolute bottom-0 right-1 z-10 pointer-events-none">
                    <p className="text-[10px] uppercase tracking-widest text-white/40 font-semibold">
                        {pageInfo}
                    </p>
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
                className="flex items-center justify-center rounded px-3 py-1 bg-white/20 hover:bg-white/40 active:bg-white/70"
            >
                ‹
            </button>
            
            <div className='text-center text-[11px] flex uppercase whitespace-nowrap text-gray-400 font-medium'>
                {pageInfo}
            </div>

            <button 
                onClick={() => rendition?.next()}
                className="flex items-center justify-center rounded px-3 py-1 bg-white/20 hover:bg-white/40 active:bg-white/70"
            >
                ›
            </button>
        </div>

        {/* Right Side: Spacer to keep center balanced */}
        <div className="w-1/3"></div>
    </div>
            )}
        </div>
    </>
);


}