/* Parses a playlist pasted out of Spotify's desktop app.
 *
 * Lifted from lukebox's import.mjs, unchanged in behaviour, so the two projects
 * read the same .txt pastes. The paste is a flat run of lines with no
 * delimiters of its own. What makes it parseable is the duration: Spotify
 * prints exactly one per row and never prints anything else that looks like
 * m:ss, so every duration line is the end of a track and the start of the next.
 * Everything in between is
 *
 *     title, artist [ , artist ]* [ & artist ], album?
 *
 * where the separators arrive on their own lines because they are their own
 * elements in Spotify's markup, and the album is missing on rows that came from
 * a local file rather than the catalogue.
 */

// m:ss, mm:ss or h:mm:ss — the hour form shows up on the long mixes.
const DURATION = /^\d+:\d{2}(?::\d{2})?$/;
const SEPARATOR = /^[,&]$/;

export function parse(text) {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\r/g, '').replace(/ /g, ' ').trim())
    .filter((l) => l !== '');

  const tracks = [];
  let block = [];

  for (const line of lines) {
    if (!DURATION.test(line)) { block.push(line); continue; }
    const track = readBlock(block, line);
    if (track) tracks.push(track);
    block = [];
  }

  if (block.length) {
    throw new Error(`unterminated track at end of file: ${JSON.stringify(block)}`);
  }
  return tracks;
}

function readBlock(block, durationText) {
  if (block.length < 2) return null; // stray text, not a row

  const [title, ...rest] = block;

  // Walk the artist run: a name, then for as long as the next line is a
  // separator, another name. Whatever survives the walk is the album.
  const artists = [rest[0]];
  let i = 1;
  while (i + 1 < rest.length && SEPARATOR.test(rest[i])) {
    artists.push(rest[i + 1]);
    i += 2;
  }
  const tail = rest.slice(i);

  return {
    title,
    artists,
    album: tail.length ? tail.join(' ') : null,
    duration: durationText,
    seconds: toSeconds(durationText),
  };
}

export function toSeconds(text) {
  return text.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
}
