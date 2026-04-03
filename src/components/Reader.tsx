import type {Book} from '../App'
import {useRef, useState, useEffect} from 'react'
import ePub from 'epubjs';
import localforage from 'localforage';

interface readerProps {
    bookData: Book,
    onClose: () => void
}

export default function Reader({bookData, onClose}: readerProps) {

    // define a ref html div element to pass to epubjs so it can render the book into it

    const viewerRef = useRef<HTMLDivElement>(null); // this is just a plain div element. <div><div/>

    // define rendition and pageInfo states for epubjs
    const [rendition, setRendition] = useState<any>(null)
    const [pageInfo, setPageInfo] = useState<string>("Calculating")

    // define a state to control the visibility of the header
    const [showHeader, setShowHeader] = useState<boolean>(false);

    // Use useEffect to make sure book is loaded then check if both viewerRef and bookData.data are present.
    // Setup new rendition, generate page locations and update state whenever rendition is "relocated" (page changes)

    useEffect(() => {

        if(!viewerRef.current || !bookData.data) return; // stop execution if either are false/missing

        // initialize book using the data and epubjs and create and display rendition
        const book = ePub(bookData.data);
        const newRendition = book.renderTo(viewerRef.current, {
            width: "100%",
            height: "100%",
            spread: "none"
        })

        // Inject CSS into the epub iframe to prevent text selection and touch callouts. Otherwise text will get selected whenever user clicks to change page on a touch screen.
        newRendition.themes.default({
            "body": {
                "-webkit-user-select": "none",
                "user-select": "none",
                "-webkit-touch-callout": "none" // Disables the iOS/Android popup menu
            }
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

        book.ready.then(() => {
            return book.locations.generate(1024); // 1024 characters define a location chunk, which epub.js uses to approximate pages.
        }).then((_locations) => {
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
            book.destroy();
        };


    }, [bookData]);


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
            // get the width of the viewer
            const viewerWidth = viewerRef.current ? viewerRef.current.clientWidth : window.innerWidth;

            const clickX = e.clientX % viewerWidth;
            
            if (clickX < viewerWidth * 0.3) {
                rendition.prev();
            } else if (clickX > viewerWidth * 0.7) {
                rendition.next();
            } else {
                setShowHeader((prev) => !prev);  // set showHeader to flase if true and true if flase
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


    // WHAT THE READER ACTUALLY RENDERS:

    return (
        <div className='flex flex-col absolute w-full h-full top-0'> {/* The parent div needs to have a defined w and h because epubjs requires this for the div it renders the book into */}
            {/* Conditionally rendered Header */}
            {

                showHeader && (
                    <div className='flex justify-start items-center'>
                        <button onClick={onClose} className='bg-[#e24741] rounded text-white p-1 mt-1 pointer'>Close</button>
                    </div>
                )   
               
            }

            {/* The viewer */}

            <div ref={viewerRef} className='flex-1 overflow-hidden'></div>

            {/* Footer with page numbers */}
            <div className='p-0 justify-center flex'>
                Page {pageInfo}
            </div>


        </div>
    )


}