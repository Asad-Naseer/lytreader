import { useState } from "react";
import "./App.css";
import Navigation from "./components/Navigation.tsx";
import Shelf from "./components/Shelf.tsx";
import { useEffect } from "react";
import Reader from "./components/Reader.tsx";
import localforage from "localforage";

export type Book = {
  id: string;
  name: string;
  data: ArrayBuffer;
  cover: string;
};

function App() {
  const [books, setBooks] = useState<Book[]>([]); // books is the state var and setBooks is the setter func.
  const [activeBook, setActiveBook] = useState<Book | null>(null);

  // handle open and close book logic
  const handleOpenBook = (book: Book) => {
    setActiveBook(book);
  };

  const handleCloseBook = () => {
    setActiveBook(null);
  };

  // load books that are saved in device storage from indexedDB on initial mount

  useEffect(() => {
    const loadSavedBooks = async () => {
      try {
        const keys = await localforage.keys();

        // filter the books
        const bookKeys = keys.filter((key) => key.startsWith("book-"));

        // fetch all books that are in indexedDB
        const savedBooks = await Promise.all(
          // we need to use Promise.all here because localforage returns a promise for each key. React state expects real data not promises. Promise.all waits until all promises are resolved.
          bookKeys.map((key) => localforage.getItem<Book>(key)),
        );

        // Filter out any null values
        setBooks(savedBooks.filter(Boolean) as Book[]);
      } catch (error) {
        console.error("Failed to load books from storage:", error);
      }
    };

    loadSavedBooks();
  }, []); // passing an empty array means that this will only run ONCE when the component mounts & will not run again on reloads.

  // useEffect(() => {
  //   console.log("active book:", activeBook);
  // }, [activeBook]);

  useEffect(() => {
    console.log("State updated:\n", books);
  }, [books]);

  return (
    <>
      {!activeBook ? (
        <>
          <Navigation setBooks={setBooks} />
          <Shelf books={books} onOpenBook={handleOpenBook} />
        </>
      ) : (
        <>
          <Reader onClose={handleCloseBook} bookData={activeBook} />
        </>
      )}
    </>
  );
}

export default App;
