// Thin wrapper over Firebase Realtime Database + anonymous auth.
// Everything else in the app talks to this small API, so the SDK stays in one place.
import { firebaseConfig } from './firebase-config.js';

const V = '10.12.2';
const CDN = `https://www.gstatic.com/firebasejs/${V}/`;

export async function create() {
  if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PASTE')) {
    throw new Error('firebase-config.js is not filled in yet. See README.md, step 5.');
  }
  const [appMod, authMod, db] = await Promise.all([
    import(CDN + 'firebase-app.js'),
    import(CDN + 'firebase-auth.js'),
    import(CDN + 'firebase-database.js'),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);

  const user = await new Promise((resolve, reject) => {
    const off = authMod.onAuthStateChanged(auth, (u) => { if (u) { off(); resolve(u); } });
    authMod.signInAnonymously(auth).catch(reject);
  });

  const d = db.getDatabase(app);
  let offset = 0;
  await Promise.race([
    new Promise((resolve) => {
      db.onValue(db.ref(d, '.info/serverTimeOffset'), (s) => { offset = s.val() || 0; resolve(); });
    }),
    new Promise((resolve) => setTimeout(resolve, 6000)),
  ]);

  const R = (p) => db.ref(d, p);
  return {
    uid: user.uid,
    now: () => Date.now() + offset, // server-synced clock
    set: (p, v) => db.set(R(p), v),
    update: (p, v) => db.update(R(p), v),
    get: async (p) => (await db.get(R(p))).val(),
    onValue: (p, cb) => db.onValue(R(p), (s) => cb(s.val())),
    onChild: (p, h) => {
      const offs = [];
      if (h.added) offs.push(db.onChildAdded(R(p), (s) => h.added(s.key, s.val())));
      if (h.changed) offs.push(db.onChildChanged(R(p), (s) => h.changed(s.key, s.val())));
      if (h.removed) offs.push(db.onChildRemoved(R(p), (s) => h.removed(s.key)));
      return () => offs.forEach((f) => f());
    },
    onDisconnectSet: (p, v) => db.onDisconnect(R(p)).set(v),
  };
}
