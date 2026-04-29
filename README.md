# LinkedIn Design Builder

Team web app for generating LinkedIn carousel PNGs from locked HTML/CSS templates.

## What It Does

- Runs as a local/network web app.
- Upload an HTML template, optional CSS file, and replacement images.
- Choose the number of slides.
- Add slide copy in the browser.
- Assign a specific replacement image to each slide.
- Exports clean PNGs named `slide-01.png`, `slide-02.png`, etc.
- Saves outputs on the server machine in `~/LinkedIn Design Builder Web/Exports/`.
- Creates `export-report.txt` with slide dimensions, validation status, image mapping, font sizing, warnings, and optional OpenAI review.

## OpenAI Validation

OpenAI validation is optional and runs only on the backend.

Create a `.env` file:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5.2
PORT=4173
```

If `OPENAI_API_KEY` is not set, the app still works with local rule-based validation.

## Setup

```bash
npm install
npm run install:browsers
```

## Run For Your Team

```bash
npm run dev
```

Open on the server computer:

```text
http://localhost:5173
```

Open from another computer on the same network:

```text
http://YOUR-COMPUTER-IP:5173
```

The backend API runs on port `4173`.

## Deploy On Railway

This project includes a `Dockerfile`, so Railway will build it as a container when the repository is connected.

1. Push this app folder to a GitHub repository.
2. In Railway, create a new project from that GitHub repo.
3. Add these service variables in Railway:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5.2
APP_USERNAME=team
APP_PASSWORD=choose_a_strong_password
```

Railway sets `PORT` automatically, so do not hard-code it there.

After deployment, open the Railway public domain. The app will ask for the username/password above, export the PNG slides on the Railway server, and download the results as a ZIP file.

### Railway Notes

- The Docker image uses the official Playwright base image so Chromium is available for PNG exports.
- `railway.json` forces Railway to use the root `Dockerfile`. If exports fail with a missing Chromium error, confirm both files are in the GitHub repository root and redeploy.
- Output files are temporary server files. Download the ZIP after each export.
- If Railway shows a build from the Dockerfile in the deploy logs, it picked up the correct deployment path.

## Template Contract

Best results come from marking the template:

- `data-lidb-export` on the actual slide/card to export
- `data-lidb-copy` on the copy element to replace
- `data-lidb-image` on the image element to replace
- `data-lidb-safe-area` around the allowed text area
- `data-lidb-slide-number` for the current slide number
- `data-lidb-total-slides` for total slide count

If markers are missing, the app uses fallback detection for the slide card, text, and image, but marked templates are more reliable.

## Notes

- Export format is PNG.
- Design remains locked.
- The app may adjust text size, line breaks, text box fit, and vertical balance.
- It should not change colors, fonts, backgrounds, image placement, structure, overlays, footer, or page-number style.
