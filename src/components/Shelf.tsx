import type { Book } from "../App";

interface shelfProps {
  books: Book[];
  onOpenBook: (book: Book) => void;
  onDeleteBook: (book: Book) => void;
}

function Shelf({ books, onOpenBook, onDeleteBook }: shelfProps) {
  if (books.length === 0) {
    return (
      <div className="w-screen h-screen flex items-center justify-center text-gray">
        No Books Imported
      </div>
    );
  }

  return (
    <div className="flex flex-wrap">
      {books.map((book) => (
        <div
          key={book.id}
          className="w-32 m-0 p-1 pointer lg:w-48"
          onClick={() => {
            onOpenBook(book);
            console.log("book clicked");
          }}
        >
          <div className="relative inline-block">
            <button
              type="button"
              aria-label={`Delete ${book.name}`}
              title={`Delete ${book.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteBook(book);
              }}
              className="absolute top-0 left-0 z-10 w-6 h-6 rounded-none bg-black/70 hover:bg-red-600 text-white text-xs flex items-center justify-center border border-white/20 cursor-pointer transition-colors"
            >
              ✕
            </button>
            <img src={book.cover} alt={book.name} className="br3 block" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default Shelf;