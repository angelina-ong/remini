/* remini cloud settings. The OAuth client ID is public by design (it is not a secret).
 * Allowed origins for this client: https://angelina-ong.github.io and http://localhost:8766. */
export const CLIENT_ID = '315346977199-t96mr12voubq74fhdeh15ohl3da66qoo.apps.googleusercontent.com';

// Read-only: remini can look at Drive files but can never change or delete anything.
export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

// How the sign-in screen refers to the one Google account to use (kept generic: this site is public).
export const HOME_ACCOUNT_NAME = 'your remini home account';

// The photo list the PC app uploads to Drive.
export const CATALOG_NAME = 'remini-catalog.json';

// How much space thumbnails may use on the phone before the oldest are removed.
export const THUMB_CACHE_BYTES = 150 * 1024 * 1024;
