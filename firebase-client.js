// Import Firebase directly from the CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

// 1. Paste your Firebase configuration object here
const firebaseConfig = {
  apiKey: "AIzaSyAiX0OPqh8dvHaDaMcjJznTNp7XE1iuPE4",
  authDomain: "study-board-6c9d0.firebaseapp.com",
  projectId: "study-board-6c9d0",
  storageBucket: "study-board-6c9d0.firebasestorage.app",
  messagingSenderId: "706066762938",
  appId: "1:706066762938:web:6e0cde4838353927b74683",
  measurementId: "G-EZX2Q1Y5XS"
};
// 2. Initialize Firebase
const app = initializeApp(firebaseConfig);
const messaging = getMessaging(app);

// 3. Paste your VAPID Key
const myVapidKey = "BHaRFc-faH5vI-yIhWjd0n1BF3CQ0zmkHHJcJOVT9mYLaloj_BB0qaSjfAJ4Utm1BVyNLr1-vq-cNiFToCDgCFs"; 

// 4. Wrapped inside a function so it only runs on a user click
window.requestFirebaseToken = async function() {
  try {
    // 1. Explicitly ask for iOS permission on button tap
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      alert("Permission was not granted: " + permission);
      return;
    }

    // 2. Wait for service worker
    const registration = await navigator.serviceWorker.register('./sw.js');
    const readyRegistration = await navigator.serviceWorker.ready;

    // 3. Request the token from Firebase
    const currentToken = await getToken(messaging, {
      vapidKey: myVapidKey,
      serviceWorkerRegistration: readyRegistration
    });

    if (currentToken) {
      console.log("Token:", currentToken);
      alert("Success! Firebase token generated.");
    } else {
      alert("No token available.");
    }
  } catch (err) {
    console.error("Token error:", err);
    alert("Firebase Error: " + err.message);
  }
};
