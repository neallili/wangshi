'use strict';
// Splits a streamed top-level JSON array into the source text of each element object, so a
// conversations.json of any size is handled one conversation at a time (never one giant string).
// It only tracks nesting depth, strings and escapes; each object is validated by JSON.parse later.

class JsonArrayError extends Error {}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d, 0xfeff]);

class ArraySplitter {
  constructor() {
    this.started = false; // saw the opening '['
    this.ended = false; // saw the matching ']'
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.inObject = false; // inside a top-level element object
    this.pieces = []; // text of the current object from earlier chunks
  }

  /** Feeds a chunk of text; returns the complete element objects (as text) that ended in it. */
  push(chunk) {
    const out = [];
    let objStart = this.inObject ? 0 : -1;
    for (let i = 0, n = chunk.length; i < n; i++) {
      const c = chunk.charCodeAt(i);
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (c === 0x5c) this.escape = true; // backslash
        else if (c === 0x22) this.inString = false; // quote
        continue;
      }
      if (!this.started) {
        if (WS.has(c)) continue;
        if (c !== 0x5b) throw new JsonArrayError('top level is not an array');
        this.started = true;
        this.depth = 1;
        continue;
      }
      if (this.ended) {
        if (WS.has(c)) continue;
        throw new JsonArrayError('content after the array');
      }
      switch (c) {
        case 0x22:
          this.inString = true;
          break;
        case 0x7b: // {
          if (this.depth === 1) {
            this.inObject = true;
            objStart = i;
          }
          this.depth++;
          break;
        case 0x5b: // [
          this.depth++;
          break;
        case 0x7d: // }
        case 0x5d: // ]
          this.depth--;
          if (this.depth === 1 && this.inObject && c === 0x7d) {
            this.pieces.push(chunk.slice(objStart, i + 1));
            out.push(this.pieces.length === 1 ? this.pieces[0] : this.pieces.join(''));
            this.pieces = [];
            this.inObject = false;
            objStart = -1;
          } else if (this.depth === 0) {
            if (c !== 0x5d) throw new JsonArrayError('mismatched brackets');
            this.ended = true;
          } else if (this.depth < 0) {
            throw new JsonArrayError('mismatched brackets');
          }
          break;
        default:
          break;
      }
    }
    if (this.inObject) this.pieces.push(objStart > 0 ? chunk.slice(objStart) : chunk);
    return out;
  }

  /** Call after the last chunk; throws when the array was cut off. */
  end() {
    if (!this.started || !this.ended) throw new JsonArrayError('array is incomplete');
  }
}

module.exports = { ArraySplitter, JsonArrayError };
