// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's reading of the input
// {text, header} — the value {columns, rows, errors} — and is written to spend as little CPU as it can.
//
// The reading policy is csv-reader's own, followed point for point:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it is one
//     quote, and each CRLF or lone CR inside it is read as LF; what follows the closing quote, up to
//     the next comma or line break, is appended as it stands (quote_junk, when the field ends); a
//     quote that never closes is a literal character and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it
//     (every record when header is false), each padded with "" (short_row, with fields: its count)
//     or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside quotes counted), row its record's index in rows, null for
//     the header; a record's short_row or long_row is recorded when the record ends.
//
// Where the speed comes from: the reference builds every field a character at a time. Here a field
// is almost always one slice of the input: unquoted fields are scanned by char code only until a
// comma, a line break or a stray CR shows up, and quoted fields jump from quote to quote with
// indexOf, their content taken in whole segments (only a segment holding a CR is rebuilt, to fold
// its CRs and CRLFs into LFs). Nothing is concatenated per character on the common paths, and the
// field readers hand their results back through shared variables, not fresh tuples.

const COMMA = 0; // the field ended at a comma: the record goes on
const BREAK = 1; // the field ended at a line break: the record ends
const END = 2; // the field ended at the end of the text: the record ends

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and how many characters of the text were kept
  // into it past its prefix (the quote_junk test).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads an unquoted field whose kept text starts as `prefix` ('' normally, '"' when a quoted field
  // turned out never to close and its text is read again). Sets fValue, fEnded and fAdded.
  function readUnquoted(prefix) {
    let start = pos;
    let parts = null; // kept segments, once a stray CR forces the field to be pieced together
    let added = 0;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      // Every terminator's code is at most 44 (',' 44, LF 10, CR 13), so a character above it —
      // most of a field — is kept with this one comparison.
      if (c <= 44) {
        if (c === 44) {
          // ','
          const tail = text.slice(start, pos);
          pos += 1;
          added += tail.length;
          fEnded = COMMA;
          fAdded = added;
          fValue = parts === null ? prefix + tail : prefix + parts.join('') + tail;
          return;
        }
        if (c === 10 || c === 13) {
          if (c === 13 && text.charCodeAt(pos + 1) !== 10) {
            // A lone CR is dropped (stray_cr) and the field is pieced together from its segments.
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            if (parts === null) parts = [];
            const kept = text.slice(start, pos);
            parts.push(kept);
            added += kept.length;
            pos += 1;
            start = pos;
            continue;
          }
          // LF, or a CRLF: the field ends and so does the record.
          const tail = text.slice(start, pos);
          pos += c === 13 ? 2 : 1;
          line += 1;
          added += tail.length;
          fEnded = BREAK;
          fAdded = added;
          fValue = parts === null ? prefix + tail : prefix + parts.join('') + tail;
          return;
        }
      }
      pos += 1;
    }
    const tail = text.slice(start, pos);
    added += tail.length;
    fEnded = END;
    fAdded = added;
    fValue = parts === null ? prefix + tail : prefix + parts.join('') + tail;
  }

  // Takes the quoted content in [from, to) into `parts` (or returns it whole when `parts` is null):
  // CRLFs and lone CRs become LF, and every line break inside counts a line. Returns the segment's
  // text when `parts` is null, else null (the segment was pushed onto `parts`).
  function takeSegment(from, to, parts) {
    if (from >= to) return '';
    // A CR anywhere in the segment forces a rebuild; without one the segment stands as it is and
    // only its LFs need counting.
    const cr = text.indexOf('\r', from);
    if (cr === -1 || cr >= to) {
      const lf = text.indexOf('\n', from);
      if (lf !== -1 && lf < to) {
        let n = 0;
        for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n += 1;
        line += n;
      }
      const s = text.slice(from, to);
      if (parts === null) return s;
      parts.push(s);
      return null;
    }
    // Rebuild the segment a piece at a time, folding each CR or CRLF into one LF.
    const built = [];
    let seg = from;
    let i = from;
    while (i < to) {
      const c = text.charCodeAt(i);
      if (c === 13) {
        built.push(text.slice(seg, i), '\n');
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        seg = i;
        continue;
      }
      if (c === 10) line += 1;
      i += 1;
    }
    built.push(text.slice(seg, to));
    const s = built.join('');
    if (parts === null) return s;
    parts.push(s);
    return null;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let segStart = pos;
    let parts = null;
    let value = null;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again
        // as unquoted, from just past the quote, with the line count as it was at the quote.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one literal quote in the value, and the field goes on.
        if (parts === null) parts = [];
        takeSegment(segStart, q, parts);
        parts.push('"');
        pos = q + 2;
        segStart = pos;
        continue;
      }
      // The closing quote.
      if (parts === null) {
        value = takeSegment(segStart, q, null);
      } else {
        takeSegment(segStart, q, parts);
        value = parts.join('');
      }
      pos = q + 1;
      break;
    }
    if (pos >= len) {
      fValue = value;
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted();
      } else {
        quoted = false;
        readUnquoted('');
      }
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? columns ?? [] : null, rows, errors };
}
