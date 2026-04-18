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

    // define bookHighlightsKey for loading book highlights
    const bookHighlightsKey = `highlights-${bookData.id}`;

    // define list state for highlights
    const [highlightsList, setHighlightsList] = useState<{cfi: string, text: string}[]>([]);

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
            minSpreadWidth: 1000,
            gap: 40
        }as any)

        // Inject CSS into the epub iframe to prevent text selection and touch callouts. Otherwise text will get selected whenever user clicks to change page on a touch screen.
        newRendition.themes.default({
            "body": {
                // "-webkit-user-select": "none",
                // "user-select": "none",
                "-webkit-touch-callout": "none", // Disables the iOS/Android popup menu
                "color": "#c2c2c2"
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
                newRendition.display(savedCfi);
            } else {
                newRendition.display();
            }
        }

        loadSavedPositions();
        

        // now calculate and update pageInfo state (page numbers)

        newBook.ready.then(() => {
            return newBook.locations.generate(1024); // 1024 characters define a location chunk, which epub.js uses to approximate pages.
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


    // Apply and Saved Fontsize whenever it changes
    useEffect(() => {
        if (rendition) {
            rendition.themes.fontSize(`${fontSize}%`);
            // Save globally to persist accross book reloads
            localforage.setItem('reader-font-size', fontSize);
        }
    }, [fontSize, rendition]);


    // SETTING UP NAVIGATION USING keyboard, clicks and swipes
    // use useEffect to check if rendition state is live before setting up navigation controls.

    useEffect(() => {
        if (!rendition) return; // stop execution if rendition is null or falsy

        // 1. setup Spacebar and Shift + spacebar to go forward or backward.
        const handleKeyDown = (e: KeyboardEvent) => {
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
                const { cfi, contents } = pendingHighlight.current;
                finalizeHighlight(cfi, contents)
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
            if (swipeDistance > 50) { 
                rendition.next(); // user swiped from right to left
            } else if (swipeDistance < -50) {
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

                // mark the cfi and contents passed to handleSelected as pending highlight
                pendingHighlight.current = {cfi: cfiRange, contents}

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


    // Render Highlights function
    const renderHighlights = () => {
        if (highlightsList.length === 0) {
            return <p className="p-4 text-center text-gray-500">No highlights yet.</p>;
        }

        return highlightsList.map((item, index) => {
            return (
                <button
            key={item.cfi || index}
            className='text-left w-full py-3 px-4 border-b'
            onClick={() => {
                rendition.display(item.cfi);
                setShowSidebar(false);
            }}
            >

                <p className="text-sm italic line-clamp-3 leading-relaxed">
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


    // WHAT THE READER ACTUALLY RENDERS:

    return (
        <div className='flex flex-col absolute w-full h-full top-0 overflow-hidden'> 

            {/* TOP BAR */}
            {showHeaderFooter && (
                <div className='absolute bg-[#1c1c1c] top-0 left-0 w-full z-10 flex justify-between items-center p-3 shadow-md'>
                    <button 
                        onClick={() => {
                            setShowSidebar(true);
                            setShowHeaderFooter(false); 
                        }} 
                        className='rounded py-2 pointer font-medium'>
                        ☰ Menu
                    </button>

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
                                className={`flex-1 py-4 font-semibold ${sidebarTab === 'toc' ? 'border-b-4 ' : 'text-gray-500'}`}
                                onClick={() => setSidebarTab('toc')}
                            >
                                Chapters
                            </button>
                            <button 
                                className={`flex-1 py-4 font-semibold ${sidebarTab === 'highlights' ? 'border-b-4 ' : 'text-gray-500'}`}
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
                                <div className="flex flex-col">
                                    {renderHighlights()}
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
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
                    <p className="text-[10px] uppercase tracking-widest text-white/40 font-semibold">
                        {pageInfo}
                    </p>
                </div>
            )}



            {/* FOOTER */}
            {/* FOOTER - Now conditional */}
        {showHeaderFooter && (
            <div className='p-1 flex items-center justify-between border-t relative z-10 bg-[#1c1c1c]'>
                
                <div className="relative w-1/3 pl-4">
                    <button 
                        onClick={() => setShowFontMenu(!showFontMenu)} 
                        className="ml-4 p-2 rounded font-bold w-10 h-10 flex items-center justify-center">
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

                <div className='text-center'>
                    Page {pageInfo}
                </div>

                <div className="w-1/3"></div>
            </div>
        )}
    </div>
    )


}