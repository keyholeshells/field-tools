# Field Tools · Laingsburg Bands

A small offline app for the band director: show tracks, metronome, tuner and stopwatch.
Once it's on a phone's home screen it opens and plays with no signal.

- Published by GitHub Pages from this repo (`main`, root): https://keyholeshells.github.io/field-tools/
- **Source lives in the boosters site repo** (`keyholeshells/laingsburg-band-booster-website`, folder `field-app/`).
  Edit there, run `node scripts/sync-tool-engine.js`, bump `VERSION` in `sw.js`, then copy the folder here.
- No tracks or keys are stored here. The install link from the Stage (📲 Offline app) carries a private key;
  the app uses it to fetch the Field Pack list from `https://www.laingsburgbandboosters.org/_functions/fieldTracks`
  and saves the tracks on the phone.
- Hosted here instead of on Wix because Wix blocks service workers (what makes a page work offline) on everything it serves.
