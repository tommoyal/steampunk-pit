# 1577 Steampunk Pit App

The competition pit app for FRC Team 1577. It runs as a full-screen dashboard on the pit TV, and members open the same link on their phones.

## What it does
- **Live stream:** the event's official webcast from The Blue Alliance, always on screen. You can also paste a custom Twitch or YouTube link.
- **Our match list:** every 1577 match with partners, opponents, results and Statbotics win chances.
- **Queue timer:** live queue times from Nexus. Without Nexus, it uses match time minus the "queue lead".
- **Next match card:** bumper color, station, partners and opponents, the countdown, checklist status and the battery picked.
- **Pre-match checklist:** tap-through items, shared with the TV. You can edit the items in Settings.
- **Battery tracker:** status (ready, charging, in robot, resting, retired), charge timer, voltage and resistance readings, and which matches each battery was used in.
- **Post-match debrief:** what worked, what broke, driver notes and a star rating.
- **Rankings:** our rank, record, ranking score, projected wins and the full table with EPA.
- **Playoffs:** alliances, the full double-elimination bracket (M1–M13 and best-of-3 finals), our alliance's status (upper or lower bracket, eliminated, champions), where a win or a loss sends us, and elimination-match warnings on the next-match card. Try it with ⚙ (top bar) → Demo phase → Playoffs.
- **Event stages:** the app follows the event (Qualifications → Alliance selection → Playoffs → Event complete) and changes the TV layout to match. During alliance selection it shows the live draft board, our status, and the best teams still available by EPA.
- **Pit finder (📍 Pits tab):** search any team's pit, see the pits of our next match's partners and opponents, fix or add pit numbers (shared with the team), and a shared photo of the event's pit map. Pits fill in automatically when the event uses Nexus pit maps.
- **Alerts:** a banner and sound X minutes before queueing, at queue time, on Nexus "Now queuing" or "On deck", and when a result posts. Phone notifications work while the app is open.
- **Call to pit:** the 📣 button in the corner calls one member (or everyone) back to the pit. Their phone and the TV alarm until they tap "On my way". Needs team sync, and each member's name in Settings → Your name and Team members.
- **Phone alerts (ntfy):** alerts that reach locked phones through the free ntfy app. Each member subscribes to the Team channel, the Queue channel if they're drive team or pit crew, and their personal channel (Settings → Phone alerts). Only the pit TV should have "This device sends queue alerts" turned on.
- **Offline mode:** the app and the last event data are saved on the device and keep working without Wi-Fi.
- **Demo mode:** a fake live event so you can try the app any time.

## Setup (once)
1. **Host it.** Put these files in a GitHub repo and turn on GitHub Pages (Settings → Pages → Deploy from branch → `main` / root). Open the `https://<user>.github.io/<repo>/` link. The Twitch player only works from a real web address, not from a file opened on disk.
2. **TBA key (required):** thebluealliance.com → Account → Read API Keys → add a key, then paste it in Settings.
3. **Nexus key (optional):** frc.nexus → API. This gives live queue times.
4. **Event:** in Settings, set Season, then press **Find our events** and tap the event. Turn **Demo mode** off and press **Save**.
5. **Team sync (optional, recommended):** this shares the checklist, batteries and debriefs between the TV and phones.
   - Go to console.firebase.google.com → Add project, with Analytics off.
   - Build → Firestore Database → Create database (production mode).
   - Go to Firestore → Rules and paste:
     ```
     rules_version = '2';
     service cloud.firestore {
       match /databases/{db}/documents {
         match /teams/1577/{document=**} { allow read, write: if true; }
       }
     }
     ```
   - Go to Project settings → Your apps → Web (`</>`) → register. Copy the `firebaseConfig = { … }` block into Settings → Team sync, then Save.
6. **Phones:** Settings → **Copy setup link** and send it to the team chat. Opening the link sets up their app with the same event, keys and sync. Then use "Add to Home Screen".
7. **Pit TV:** open the link in Chrome, tick **Pit TV mode** in Settings, click once anywhere to allow sound, and press ⛶ for fullscreen. The screen stays awake.

## Updating
Change the files and push. The app always loads the newest files when it's online (it only uses its saved copy when offline), and it reloads itself when a new version is installed. Bumping `CACHE` in `sw.js` is still a good idea so the saved offline copy is refreshed.
