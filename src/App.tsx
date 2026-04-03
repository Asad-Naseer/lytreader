import { useState } from 'react'
import './App.css'
import Navigation from './components/Navigation.tsx'
import Shelf from './components/Shelf.tsx'
import { useEffect } from 'react';
import Reader from './components/Reader.tsx'

export type Book = {
    id: string,
    name: string,
    data: ArrayBuffer,
    cover: string
  }

function App() {

  const [books, setBooks] = useState<Book[]>([]); // books is the state var and setBooks is the setter func.
  const [activeBook, setActiveBook] = useState<Book | null>(null);

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
