// Picks the realtime backend. Real Firebase by default; add ?mock=1 to the URL to use the
// in-browser mock (BroadcastChannel between tabs) for local testing without any Firebase project.
export async function connect() {
  const mock = new URLSearchParams(location.search).has('mock');
  const impl = mock ? await import('./dev/mock-backend.js') : await import('./firebase-backend.js');
  return impl.create();
}
