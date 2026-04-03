import { useState } from 'react'
import './App.css'
import Navigation from './components/Navigation.tsx'
import Shelf from './components/Shelf.tsx'
import { useEffect } from 'react';
import Reader from './components/Reader.tsx'
import localforage from 'localforage';

export type Book = {
    id: string,
    name: string,
    data: ArrayBuffer,
    cover: string
  }

function App() {

  const [books, setBooks] = useState<Book[]>([]); // books is the state var and setBooks is the setter func.
  const [activeBook, setActiveBook] = useState<Book | null>(null);


  // load books that are saved in device storage from indexedDB on initial mount

  useEffect(() => {

    const loadSavedBooks = async () => {
      try {
        const keys = await localforage.keys();

        // filter the books
        const bookKeys = keys.filter(key => key.startsWith('book-'));

        // fetch all books that are in indexedDB
        const savedBooks = await Promise.all(
          bookKeys.map(key => localforage.getItem<Book>(key))
        );

        // Filter out any null values
        setBooks(savedBooks.filter(Boolean) as Book[])
      } catch (error) {
        console.error("Failed to load books from storage:", error);
      }

    };

    loadSavedBooks();

  }, []); // passing an empty array means that this will only run ONCE when the component mounts & will not run again on reloads.




  useEffect(() => {
    console.log("active book:", activeBook);
  }, [activeBook]);

  useEffect(() => {
    console.log("State updated:\n", books);
  }, [books]);

  return (
    <>
      {!activeBook ? (
        <>
          <Navigation setBooks={setBooks} />
          <Shelf books={books} onOpenBook={(book) => setActiveBook(book)} />
        </>  
      ) : (
        <>
        <Reader onClose={() => setActiveBook(null)} bookData={activeBook}/>
        </>
      )

      }
    </>
  )
}

export default App
