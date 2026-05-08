import type { Book } from "../App";

interface shelfProps {
  books: Book[];
  onOpenBook: (book: Book) => void;
}

function Shelf({ books, onOpenBook }: shelfProps) {
  if (books.length === 0) {
    return (
      <div className="w-screen h-screen flex items-center justify-center text-gray">
        No Books Imported
      </div>
    );
  }

  return (
    <div className="flex flex-wrap">
      {books.map(
        (
          book,
          index, // basically dudeman, .map loops thru an array and returns a new array.
        ) => (
          <div
            key={index}
            className="w-32 m-0 p-1 pointer lg:w-48"
            onClick={() => {
              onOpenBook(book);
              console.log("book clicked");
            }}
          >
            <img src={book.cover} alt="cover" className="br3" />
          </div>
        ),
      )}
    </div>
  );
}

export default Shelf;
