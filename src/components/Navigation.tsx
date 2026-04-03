
import ePub from 'epubjs';

function Navigation({ setBooks }: { setBooks: Function }) { // Nav gets the setter func as prop from.
    const handleOnImport = async () => {
        try {
            // 1. Get file handle
            const [fileHandle] = await (window as any).showOpenFilePicker({ // this is like a ref to the file on the user's system. We can use it to read the file.
                types: [{accept: { 'application/epub+zip': ['.epub'] } }] // the syntax is accept: {'mime-type': ['.extension']}
            });
            const file = await fileHandle.getFile(); // this is like the metadata of the file, we can get the name, size, etc. but not the content.
            const arrayBuffer = await file.arrayBuffer(); // this here gets us the content of the file as an ArrayBuffer, which is a binary representation of the file. We need this to parse the EPUB. So this is essentially just the entire file in memory as a binary blob.

            // Create a unique ID for the book
            const bookId = `${file.name}-${file.size}-${file.lastModified}`
            
            // 2. Parse EPUB
            const book = ePub(arrayBuffer); // this is the epub.js book object, which we can use to get the cover, metadata, chapters, etc.
            
            // 3. Extract cover
            const coverUrl = await book.coverUrl();
            
            // 4. Update state
            setBooks((prev: any[]) => [...prev, {
                id: bookId,
                name: file.name,
                cover: coverUrl,
                data: arrayBuffer
            }]);
            
        } catch (error) {
            console.error("Error loading epub:", error);
        }
    }
    
    return (
        <nav className="ba br3 ma2 bw2 navBorderColor">
            <button onClick={handleOnImport} className="f3 ma1 bg-transparent bn pointer pa0">Import</button>
        </nav>
    )
}

export default Navigation