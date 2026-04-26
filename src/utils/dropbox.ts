import { Dropbox, DropboxAuth } from 'dropbox';

const CLIENT_ID = 'm8vpwemeau3ud7u';
// window.location.origin + window.location.pathname ensures it includes /lytreader/
const REDIRECT_URI = window.location.origin + window.location.pathname;

// 1. Get the Access Token from URL or LocalStorage
export const getAccessToken = () => {
    const params = new URLSearchParams(window.location.hash.substring(1));
    const tokenFromUrl = params.get('access_token');

    if (tokenFromUrl) {
        localStorage.setItem('dropbox_token', tokenFromUrl);
        window.location.hash = ''; // Clean URL hash
        return tokenFromUrl;
    }

    return localStorage.getItem('dropbox_token');
};

// 2. Start OAuth Flow (Fixed for SDK v10+)
export const startDropboxAuth = () => {
    const dbxAuth = new DropboxAuth({ clientId: CLIENT_ID });
    
    // We use Implicit Grant ('token') for browser apps
    dbxAuth.getAuthenticationUrl(REDIRECT_URI, undefined, 'token')
        .then((authUrl) => {
            window.location.href = authUrl as unknown as string;
        })
        .catch((error) => console.error(error));
};

// 3. Upload File
export const uploadToDropbox = async (jsonData: object) => {
    const token = getAccessToken();
    if (!token) return startDropboxAuth();

    const dbx = new Dropbox({ accessToken: token });
    const blob = new Blob([JSON.stringify(jsonData)], { type: 'application/json' });

    try {
        await dbx.filesUpload({
            path: '/reader-backup.json',
            contents: blob,
            mode: { '.tag': 'overwrite' }
        });
        return true;
    } catch (error) {
        console.error("Dropbox Upload Error:", error);
        // If token expired, clear it
        if ((error as any).status === 401) localStorage.removeItem('dropbox_token');
        return false;
    }
};

// 4. Download File
export const downloadFromDropbox = async () => {
    const token = getAccessToken();
    if (!token) return startDropboxAuth();

    const dbx = new Dropbox({ accessToken: token });

    try {
        const response = await dbx.filesDownload({ path: '/reader-backup.json' });
        const result = response.result as any;
        // In some SDK versions, it's fileBlob, in others you read from response.result.fileBinary
        const blob = result.fileBlob || result.fileBinary;
        const text = await blob.text();
        return JSON.parse(text);
    } catch (error) {
        console.error("Dropbox Download Error:", error);
        return null;
    }
};