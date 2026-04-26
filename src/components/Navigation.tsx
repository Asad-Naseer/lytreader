import { useRef } from 'react';
import localforage from 'localforage';
import ePub from 'epubjs';
import { bufferToBase64, base64ToBuffer } from '../utils/backup';
import type { Book } from '../App';

function Navigation({ setBooks }: { setBooks: Function }) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const restoreInputRef = useRef<HTMLInputElement>(null);

    // --- SHARED BOOK PROCESSING LOGIC (Reverted/Original) ---
    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files) return;
        const newBooks: Book[] = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (!file.name.toLowerCase().endsWith('.epub')) continue;
            const bookId = `book-${file.name}-${file.size}-${file.lastModified}`;
            const existingBook = await localforage.getItem(bookId);
            if (existingBook) continue;
            try {
                const arrayBuffer = await file.arrayBuffer();
                const book = await ePub(arrayBuffer);
                const coverUrl = await book.coverUrl();
                let permanentCover = '';
                if (coverUrl) {
                    const response = await fetch(coverUrl);
                    const blob = await response.blob();
                    permanentCover = await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result as string);
                        reader.readAsDataURL(blob);
                    });
                    URL.revokeObjectURL(coverUrl);
                }
                const newBookObj: Book = {
                    id: bookId, name: file.name,
                    cover: permanentCover || '', data: arrayBuffer
                };
                await localforage.setItem(bookId, newBookObj);
                newBooks.push(newBookObj);
            } catch (error) {
                console.error(`Failed to process ${file.name}:`, error);
            }
        }
        if (newBooks.length > 0) setBooks((prev: Book[]) => [...prev, ...newBooks]);
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (folderInputRef.current) folderInputRef.current.value = '';
    };

    const handleExport = async () => {
        const keys = await localforage.keys();
        const fullData: Record<string, any> = {};
        for (const key of keys) {
            const value = await localforage.getItem(key);
            if (key.startsWith('book-') && value && typeof value === 'object') {
                const bookValue = value as any;
                fullData[key] = { ...bookValue, data: bufferToBase64(bookValue.data) };
            } else { fullData[key] = value; }
        }
        const blob = new Blob([JSON.stringify(fullData)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `reader-backup-${new Date().toISOString().slice(0,10)}.json`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const handleRestore = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const json = JSON.parse(e.target?.result as string);
                await localforage.clear();
                for (const [key, value] of Object.entries(json)) {
                    let dataToSave = value;
                    if (key.startsWith('book-') && value && typeof value === 'object') {
                        const bookValue = value as any;
                        dataToSave = { ...bookValue, data: base64ToBuffer(bookValue.data) };
                    }
                    await localforage.setItem(key, dataToSave);
                }
                window.location.reload();
            } catch (err) { alert("Restore failed"); }
        };
        reader.readAsText(file);
    };

    return (
        <nav className="ma2 br3 ba bw1 navBorderColor bg-[#1c1c1c] flex flex-col sm:flex-row items-stretch sm:items-center justify-between p-2 sm:px-4 sm:py-2 gap-3 shadow-lg">
            
            {/* HIDDEN INPUTS */}
            <input type='file' ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileChange} multiple accept=".epub" />
            <input type='file' ref={folderInputRef} style={{ display: 'none' }} onChange={handleFileChange} {...{ webkitdirectory: "", directory: "" } as any} multiple />
            <input type='file' ref={restoreInputRef} style={{ display: 'none' }} onChange={handleRestore} accept=".json" />

            {/* LEFT: Library Management (Primary) */}
            <div className="flex items-center gap-2">
                <button 
                    className="flex-1 sm:flex-none text-gray-200 bg-white/5 hover:bg-white/10 bn pointer pv2 ph3 br2 transition-all flex items-center justify-center gap-2 text-sm font-medium"
                    onClick={() => fileInputRef.current?.click()}
                >
                    <span>📖</span> <span className="dn di-ns">Import</span> Books
                </button>
                
                <button 
                    className="flex-1 sm:flex-none text-gray-200 bg-white/5 hover:bg-white/10 bn pointer pv2 ph3 br2 transition-all flex items-center justify-center gap-2 text-sm font-medium"
                    onClick={() => folderInputRef.current?.click()}
                >
                    <span>📁</span> <span className="dn di-ns">Import</span> Folder
                </button>
            </div>

            {/* RIGHT: Backup & Sync (Secondary) */}
            <div className="flex items-center justify-between sm:justify-end gap-2 border-t border-white/5 pt-2 sm:pt-0 sm:border-t-0">
                {/* Horizontal divider visible only on desktop */}
                <div className="dn di-ns bl bw1 h1 mh2 border-white-10 navBorderColor"></div>
                
                <button 
                    className="flex-1 sm:flex-none bg-blue-700 hover:bg-blue-600 white bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight"
                    onClick={handleExport}
                >
                    📤 Export
                </button>

                <button 
                    className="flex-1 sm:flex-none bg-red-800 hover:bg-red-700 white bn pointer pv2 ph3 br2 transition-colors text-xs font-bold uppercase tracking-tight"
                    onClick={() => restoreInputRef.current?.click()}
                >
                    📥 Restore
                </button>
            </div>
        </nav>
    );
}

export default Navigation;