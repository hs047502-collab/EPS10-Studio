# GitHub Pages-এ EPS 10 Studio চালু করুন

এই project **static এবং 100% browser-side**। কোনো server, database, API key, npm install বা build command লাগবে না।

## সবচেয়ে সহজ পদ্ধতি

1. GitHub-এ নতুন একটি **Public repository** তৈরি করুন। যেমন: `eps10-studio`।
2. `EPS10-Studio-GitHub-Pages.zip` extract করুন।
3. ZIP-এর ভেতরের **সব file ও folder** repository-র root-এ upload করুন:
   - `index.html`
   - `vector-eps10.html`
   - `css/`
   - `js/`
   - `samples/`
   - `.nojekyll`
   - অন্য documentation file
4. GitHub repository খুলে **Settings → Pages** যান।
5. **Build and deployment** অংশে:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/(root)`
   - **Save** চাপুন।
6. সাধারণত ১–৩ মিনিট পর GitHub URL দেখাবে:

   `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`

## Page URL

- Full preflight studio:
  `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`
- VectorPro batch page:
  `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/vector-eps10.html`

## গুরুত্বপূর্ণ

- **শুধু `index.html` upload করবেন না।** `css`, `js` এবং `samples` folder-ও একই structure-এ রাখতে হবে।
- সব asset path relative রাখা হয়েছে; তাই GitHub project-site subfolder থেকেও কাজ করবে।
- কোনো CDN বা external runtime dependency নেই।
- SVG/EPS browser-এর ভেতরেই process হয়; user file কোনো server-এ upload হয় না।
- GitHub Pages অবশ্যই HTTPS-এ site চালাবে; download ও local file processing কাজ করবে।
- নতুন code upload করার পর পুরোনো version দেখালে browser-এ `Ctrl + Shift + R` চাপুন।

## Repository structure

```text
YOUR-REPOSITORY/
├── .nojekyll
├── index.html
├── vector-eps10.html
├── css/
│   ├── app.css
│   └── vector-eps10.css
├── js/
│   ├── opentype.min.js
│   ├── veclib.js
│   ├── svgfix.js
│   ├── eps10.js
│   ├── analyze.js
│   ├── audit.js
│   ├── app.js
│   └── vector-eps10.js
└── samples/
    ├── 01-eagle.svg ...
    ├── kitchen-sink.svg
    └── DejaVuSans.ttf
```

## Update করার নিয়ম

পরিবর্তিত file repository-তে আবার upload/commit করুন। GitHub Pages নিজে থেকেই নতুন version publish করবে।
