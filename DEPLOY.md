# Deploy AccentCoach for free (GitHub Pages)

This guide is for someone who has **never deployed a website before**. You will use **GitHub**, a free service where you can store files online and get a real web address. You do **not** need to install anything on your computer except a web browser.

## Why GitHub Pages?

AccentCoach needs a normal **https://** web address so your browser allows the **microphone** and the **speech** features reliably. Opening `index.html` from your desktop sometimes works, but many browsers block the microphone on `file://` links. GitHub Pages is free and updates when you change files in the browser.

**GitHub** (https://github.com) is a website where people store project files in the cloud and share them.

## What you need

- An email address (to sign up).
- The five AccentCoach files in the `accent-coach` folder: `index.html`, `styles.css`, `app.js`, `content.js`, and optionally `README.md` (you can upload it too).

---

## Step 1 — Create a free GitHub account

1. Open **https://github.com/signup** in Chrome or Edge.
2. Follow the prompts: choose a username, enter your email, and create a password.
3. Verify your email if GitHub asks you to.

---

## Step 2 — Create a new repository named `accent-coach`

1. After you log in, click the **+** menu (plus icon) in the top-right corner.
2. Click **New repository**.
3. Under **Repository name**, type exactly: `accent-coach`
4. Leave the repository **Public** (GitHub Pages on free accounts is simplest with public repos).
5. **Do not** add a README or license template (you already have files).
6. Click **Create repository**.

You should now see an empty repository page.

---

## Step 3 — Upload your files in the browser

1. On the empty repository page, find the section that says **uploading an existing file** or click **Add file** → **Upload files**.
2. Open your computer folder that contains AccentCoach.
3. **Drag all five files** (`index.html`, `styles.css`, `app.js`, `content.js`, `README.md`) into the GitHub window. (If you skip `README.md`, that is okay.)
4. Scroll down. In the **Commit changes** box, you can leave the default message or type: `Add AccentCoach files`.
5. Click **Commit changes**.

Wait until the file list shows all uploaded files.

---

## Step 4 — Turn on GitHub Pages

1. In your repository, click the **Settings** tab (gear icon near the top).
2. In the left sidebar, click **Pages**.
3. Under **Build and deployment**, find **Source**.
4. Choose **Deploy from a branch**.
5. Under **Branch**, select **main** (or **master** if that is what you see) and folder **/ (root)**.
6. Click **Save**.

GitHub will build your site. After one or two minutes, refresh the Pages screen. You should see a green message with your **site URL**.

---

## Step 5 — Your live URL

The address will look like this:

`https://YOUR_USERNAME.github.io/accent-coach/`

Replace `YOUR_USERNAME` with the username you picked when you signed up.

Open that link in **Chrome** or **Edge** on your phone or computer.

---

## Step 6 — Use the app

1. Tap **Allow** if the browser asks for the microphone.
2. Start on **Home**, run **Microphone check**, then open any practice tab.
3. If speech recognition seems missing, confirm you are **not** in Firefox or limited Safari modes; Chrome or Edge is recommended.

---

## How to update AccentCoach later

1. Open your repository on GitHub.
2. Click the file you want to change (for example `app.js`).
3. Click the **pencil** icon **Edit this file**.
4. Paste your new version or edit the text.
5. Click **Commit changes**.

GitHub Pages will refresh in about a minute. Hard-refresh the site with **Ctrl+F5** (Windows) or **Cmd+Shift+R** (Mac) if you do not see updates.

---
 
## Run locally (optional)

You can double-click `index.html` to open the app. Some features may still work, but **microphone access is often blocked** on `file://`. If that happens, use your GitHub Pages link instead—that is the simplest path for non-technical users.

If you already use **Visual Studio Code**, the free **Live Server** extension can open the folder over `http://localhost` so the microphone is allowed. This is optional; GitHub Pages remains the easiest primary path.

---

## Troubleshooting

**Microphone not working**

- Use the **https://** GitHub link, not a `file://` path.
- Check the browser site settings (lock icon in the address bar) and allow the microphone for your GitHub domain.

**No voice playback**

- Wait a few seconds after the first load; voices download asynchronously.
- Try Chrome or Edge. Unmute system volume.

**Blank page**

- Confirm **all** files uploaded, especially `app.js` and `content.js`.
- Open the browser **Developer tools** console (optional): press **F12** → **Console** tab, refresh, and look for “404” errors for missing files.

**Speech recognition missing**

- That feature is not available in every browser. Recording and playback should still work.

---

You are done when `https://YOUR_USERNAME.github.io/accent-coach/` loads AccentCoach and the microphone check succeeds.
f