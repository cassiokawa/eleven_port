// Fixture pages served locally for the E2E run.
export const article = `<!doctype html><html><head><title>Harbour Notes</title></head><body>
<nav>Menu Home About</nav><article><h1>Harbour Notes</h1>
<p>${"The old harbour town sits quietly beside the grey northern sea, and its lamps burn late. ".repeat(6)}</p>
<h2>The Quay</h2><p>${"Fishing boats rock gently against the weathered stone of the quay at dawn. ".repeat(6)}</p>
</article></body></html>`;

// A paged "reader": ArrowRight advances; last page stays put so the capture loop sees a repeat and stops.
export const PAGES = [
  "CHAPTER ONE\n\nThe lighthouse keeper climbed the stairs each evening\nand lit the great lamp for passing ships.",
  "The sea was calm that night and the stars\nwere bright above the quiet harbour town.",
  "CHAPTER TWO\n\nMorning arrived with fog drifting slowly\nacross the water and over the empty quay.\n\nThe End",
];
export const reader = `<!doctype html><html><head><title>Mock Reader</title>
<style>body{margin:0;background:#fff}#p{font:34px/1.5 Georgia,serif;white-space:pre-wrap;padding:90px 140px;width:900px}</style></head>
<body><div id="p"></div><script>
const pages=${JSON.stringify(PAGES)};let i=0;const el=document.getElementById('p');
const show=()=>{el.textContent=pages[i]};show();
// ?quirk=clickonly: keys are ignored, only a click on the right edge turns the page.
// ?quirk=lockup: the reader stops responding after the second page, like a stuck reader.
const quirk=new URLSearchParams(location.search).get('quirk');
const next=()=>{if(i<pages.length-1&&!(quirk==='lockup'&&i>=1)){i++;show()}};
addEventListener('keydown',e=>{if(quirk!=='clickonly'&&e.key==='ArrowRight')next()});
addEventListener('click',e=>{if(quirk==='clickonly'&&e.clientX>innerWidth*0.8)next()});
</script></body></html>`;
