// Seeded PRNG so a failing scenario can be replayed with --seed N.
export function mulberry32(seed){
  let a = seed >>> 0;
  return function next(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function makeRng(seed){
  const next = mulberry32(seed);
  return {
    seed,
    next,
    int(min, max){ return min + Math.floor(next() * (max - min + 1)); },
    pick(arr){ return arr[Math.floor(next() * arr.length)]; },
    bool(p){ return next() < p; },
    sample(arr, n){
      const copy = arr.slice();
      for(let i = copy.length - 1; i > 0; i--){
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy.slice(0, Math.min(n, copy.length));
    },
    shuffle(arr){
      const copy = arr.slice();
      for(let i = copy.length - 1; i > 0; i--){
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    }
  };
}
