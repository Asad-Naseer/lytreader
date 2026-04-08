import ePub from 'epubjs';
import localforage from 'localforage';
import type {Book} from '../App.tsx';
import {useRef} from 'react';

function Navigation({ setBooks }: { setBooks: Function }) { // Nav gets the setter func as prop from.
    
    // ref to hidden file input element
    const fileInputRef = useRef<HTMLInputElement>(null);

    // This function hadles the entire logic when new files are imported into shelf:

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files) return;     // stops if there are no files imported

        const newBooks: Book[] = []; // declaring new books variable with type of Book that we imported and declaring it as empty array


        // Loop through all files, ignore anything that's not an epub, create unique ids and handle duplication.

        for (let i = 0; i < files.length; i++) {

            // declare file variable from which we will later get array buffer 
            const file = files[i];

            // 1. Ignore anything that isn't an epub
            if (!file.name.toLowerCase().endsWith('.epub')) continue // if this is true then continue runs which means end this loop and get to the next one

            // 2. Create unique Id
            const bookId = `book-${file.name}-${file.size}-${file.lastModified}`;

            // 3. Handle duplicates
            const existingBook = await localforage.getItem(bookId);     // check if a book with this id is already present
            if (existingBook) {
                console.log(`Skipping ${file.name}, already imported.`);
                continue; // get to the next loop iteration
            }

            // now we create an actual book object to push into the newBooks array
            try {
                // read file 
                const arrayBuffer = await file.arrayBuffer();
                const book = await ePub(arrayBuffer);

                // Since we need to store the cover in IndexedDB and not in browser memory (which expires on a reload) we need to store the cover url as a Base64 string. For this purpose we will be using FileReader browser API with which we can read the data of the image from the blob URL.
                
                // get temp blob url from epubjs    
                const coverUrl = await book.coverUrl();
                let permanentCover = '';        // declared as empty string but will later contain Base64 string.

                // Convert blob url to base64 string.
                if (coverUrl) {
                    const response = await fetch(coverUrl);
                    const blob = await response.blob();      // .blob() converts the file data into a blob object, chunk of binary data representing the image.

                    // In this part we get FileReader to read the blob as a DataUrl. Since FileReader returns an event and not a promise we need to wrap it in a promise and then await that.
                    permanentCover = await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result as string); // <- we need to trigger this onend event listener before we read the blob (in the next line)
                        reader.readAsDataURL(blob);
                    });

                    // Clean up temp blob url from memory
                    URL.revokeObjectURL(coverUrl);
                }

                // create the object 
                const newBookObj: Book = {
                    id: bookId,
                    name: file.name,
                    cover: permanentCover || '', // empty if no cover is present
                    data: arrayBuffer
                };


                // 4. Save the obj of this specific book to the indexedDB ( which can handle array buffers perfectly )
                await localforage.setItem(bookId, newBookObj);

                // push into the newBooks array
                newBooks.push(newBookObj);
            } catch (error) {
                console.error(`Failed to process ${file.name}:`, error);
            }
        }           // LOOP END    

        // 5. Update the state with only the new books that we now have in our newBooks array variable
        if (newBooks.length > 0) {
            setBooks((prev: Book[]) => [...prev, ...newBooks]);
        }

        // Reset the input so the user can import the same folder again when/if they add a new book to the folder.
        if (fileInputRef.current) fileInputRef.current.value = ''; // without this line the browser can't tell when we select the same folder again, because for it, the input has not changed.


    }
        
    
    return (
        <nav className="ba br3 ma2 bw2 navBorderColor">
            <input                  // <- This guy is not displayed anywhere, we need make this 'click' using another element
            type='file'
            ref={fileInputRef}
            style={{display:'none'}}
            onChange={handleFileChange}
            multiple
            {...{webkitdirectory: ""}}
            />

            <button
            className="f3 ma1 bg-transparent bn pointer pa0"
            onClick={() => fileInputRef.current?.click()}>
            Import
            </button>
        </nav>
    )
}

export default Navigation