//! Deterministic pseudo-random generator for the simulator.
//!
//! No `rand` dependency (see the crate docs): `rand` pulls in `getrandom`, which does
//! not build for `wasm32-unknown-unknown` without extra cfg flags, and a hand-written
//! generator guarantees a bit-identical stream on native and WASM.
//!
//! - Seeding: **splitmix64** expands the 64-bit user seed into the 256-bit state, so
//!   even seeds 0, 1, 2 give well-separated streams.
//! - Stream: **xoshiro256\*\*** (Blackman & Vigna), period 2^256 - 1.
//! - Normals: **Box-Muller**, generating two deviates per pair of uniforms and caching
//!   the second one. The cache is part of the generator state, so the stream a caller
//!   sees depends only on the seed and on the sequence of calls it makes.
//!
//! Every numeric output here is a regression surface: the tests pin the first values
//! for a fixed seed. Changing the algorithm changes every simulated session, so treat
//! those constants as a contract.

/// splitmix64, used only to expand the seed.
fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Seeded xoshiro256\*\* generator with a cached second Box-Muller deviate.
#[derive(Debug, Clone, PartialEq)]
pub struct Rng {
    s: [u64; 4],
    /// Second Box-Muller deviate, produced with the previous one and not yet handed out.
    cached_normal: Option<f64>,
}

impl Rng {
    /// Seed the generator. The same seed always produces the same stream, on every
    /// target, for every build of this crate.
    pub fn new(seed: u64) -> Self {
        let mut sm = seed;
        let s = [
            splitmix64(&mut sm),
            splitmix64(&mut sm),
            splitmix64(&mut sm),
            splitmix64(&mut sm),
        ];
        Rng {
            s,
            cached_normal: None,
        }
    }

    /// Raw 64-bit output.
    pub fn next_u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    /// Uniform in `[0, 1)`, using the top 53 bits (every representable f64 in the
    /// interval with 53-bit spacing is reachable; the value is never exactly 1.0).
    pub fn next_f64(&mut self) -> f64 {
        // 2^-53 exactly.
        const SCALE: f64 = 1.0 / 9_007_199_254_740_992.0;
        (self.next_u64() >> 11) as f64 * SCALE
    }

    /// Uniform integer in `[0, n)`, unbiased by modulo rejection. Panics if `n == 0`.
    pub fn below(&mut self, n: u64) -> u64 {
        assert!(n > 0, "Rng::below requires n > 0");
        // Reject the first `threshold` values so the remaining range is a multiple of n.
        let threshold = (u64::MAX - n + 1) % n;
        loop {
            let x = self.next_u64();
            if x >= threshold {
                return x % n;
            }
        }
    }

    /// Standard normal deviate, mean 0, variance 1 (Box-Muller, second value cached).
    pub fn normal(&mut self) -> f64 {
        if let Some(z) = self.cached_normal.take() {
            return z;
        }
        // u1 must be strictly positive for ln(); 0.0 has probability 2^-53 but is
        // reachable, so resample rather than returning an infinity.
        let mut u1 = self.next_f64();
        while u1 <= 0.0 {
            u1 = self.next_f64();
        }
        let u2 = self.next_f64();
        let r = (-2.0 * u1.ln()).sqrt();
        let theta = std::f64::consts::TAU * u2;
        let (s, c) = theta.sin_cos();
        self.cached_normal = Some(r * s);
        r * c
    }

    /// Normal deviate with the given mean and standard deviation.
    pub fn normal_with(&mut self, mean: f64, sigma: f64) -> f64 {
        mean + sigma * self.normal()
    }

    /// Uniformly chosen element, or `None` for an empty slice.
    pub fn choice<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() {
            return None;
        }
        let i = self.below(items.len() as u64) as usize;
        Some(&items[i])
    }

    /// In-place Fisher-Yates shuffle.
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.below(i as u64 + 1) as usize;
            items.swap(i, j);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression values, derived from this implementation on 2026-09-23 and pinned so
    /// that a change to the algorithm cannot pass silently. They are not taken from an
    /// external reference: the contract they protect is "the stream never changes",
    /// not "this is someone else's xoshiro".
    const SEED_12345_U64: [u64; 4] = [
        13_720_838_825_685_603_483,
        2_398_916_695_208_396_998,
        17_770_384_849_984_869_256,
        891_717_726_879_801_395,
    ];

    #[test]
    fn known_first_outputs_for_a_fixed_seed() {
        let mut r = Rng::new(12345);
        let got: Vec<u64> = (0..4).map(|_| r.next_u64()).collect();
        assert_eq!(
            got.as_slice(),
            &SEED_12345_U64,
            "xoshiro256** stream changed"
        );

        // The f64 stream is the u64 stream scaled: check the derivation holds.
        let mut r = Rng::new(12345);
        for &want in SEED_12345_U64.iter() {
            let got = r.next_f64();
            let expect = (want >> 11) as f64 / 9_007_199_254_740_992.0;
            assert_eq!(got, expect);
            assert!((0.0..1.0).contains(&got));
        }

        // First three normals for seed 12345.
        let mut r = Rng::new(12345);
        let normals: Vec<f64> = (0..3).map(|_| r.normal()).collect();
        let expected = [
            0.526_515_773_532_496_3,
            0.561_003_908_591_046_4,
            0.260_818_810_506_770_6,
        ];
        for (g, e) in normals.iter().zip(expected.iter()) {
            assert!((g - e).abs() < 1e-15, "normal stream changed: {g} vs {e}");
        }
    }

    #[test]
    fn splitmix_separates_adjacent_seeds() {
        let a = Rng::new(0).next_u64();
        let b = Rng::new(1).next_u64();
        let c = Rng::new(2).next_u64();
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
        // A zero seed must not give a zero state (the xoshiro failure mode).
        assert_ne!(Rng::new(0).s, [0; 4]);
    }

    #[test]
    fn two_instances_with_the_same_seed_agree() {
        let mut a = Rng::new(0xDEAD_BEEF);
        let mut b = Rng::new(0xDEAD_BEEF);
        for _ in 0..1000 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
        // ...including through the normal cache and the integer path.
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        for _ in 0..500 {
            assert_eq!(a.normal(), b.normal());
            assert_eq!(a.below(97), b.below(97));
        }
        assert_eq!(a, b);
    }

    #[test]
    fn different_seeds_give_different_streams() {
        let mut a = Rng::new(1);
        let mut b = Rng::new(2);
        let differ = (0..100).filter(|_| a.next_u64() != b.next_u64()).count();
        assert_eq!(differ, 100);
    }

    #[test]
    fn uniforms_cover_the_unit_interval() {
        let mut r = Rng::new(4242);
        let n = 100_000;
        let mut bins = [0usize; 10];
        let mut sum = 0.0;
        for _ in 0..n {
            let u = r.next_f64();
            assert!((0.0..1.0).contains(&u));
            sum += u;
            bins[(u * 10.0) as usize] += 1;
        }
        let mean = sum / n as f64;
        // sigma of the mean = sqrt(1/12/n) = 0.00091; 5 sigma = 0.0046.
        assert!((mean - 0.5).abs() < 0.005, "uniform mean {mean}");
        for (i, b) in bins.iter().enumerate() {
            let f = *b as f64 / n as f64;
            assert!((f - 0.1).abs() < 0.01, "decile {i} had fraction {f}");
        }
    }

    #[test]
    fn normal_mean_and_variance_over_1e5_samples() {
        let mut r = Rng::new(20_261_001);
        let n = 100_000;
        let (mut sum, mut sum2, mut sum3, mut sum4) = (0.0, 0.0, 0.0, 0.0);
        for _ in 0..n {
            let z = r.normal();
            sum += z;
            sum2 += z * z;
            sum3 += z * z * z;
            sum4 += z * z * z * z;
        }
        let nf = n as f64;
        let mean = sum / nf;
        let var = sum2 / nf - mean * mean;
        let skew = sum3 / nf;
        let kurt = sum4 / nf;
        // sigma of the mean = 1/sqrt(n) = 0.00316; 5 sigma = 0.0158.
        assert!(mean.abs() < 0.016, "normal mean {mean}");
        // sigma of the variance = sqrt(2/n) = 0.00447; 5 sigma = 0.0224.
        assert!((var - 1.0).abs() < 0.023, "normal variance {var}");
        // Third and fourth moments: 0 and 3 for a true normal.
        assert!(skew.abs() < 0.05, "normal skew {skew}");
        assert!((kurt - 3.0).abs() < 0.15, "normal kurtosis {kurt}");
    }

    #[test]
    fn normal_cache_is_used_and_does_not_leak_between_instances() {
        let mut r = Rng::new(99);
        let first = r.normal();
        assert!(r.cached_normal.is_some(), "second deviate should be cached");
        let second = r.normal();
        assert!(r.cached_normal.is_none());
        assert_ne!(first, second);
        // Fresh instance reproduces both.
        let mut q = Rng::new(99);
        assert_eq!(q.normal(), first);
        assert_eq!(q.normal(), second);
    }

    #[test]
    fn normal_with_scales_and_shifts() {
        let mut r = Rng::new(5);
        let mut s = Rng::new(5);
        for _ in 0..100 {
            let z = s.normal();
            assert_eq!(r.normal_with(3.0, 2.0), 3.0 + 2.0 * z);
        }
    }

    #[test]
    fn below_is_in_range_and_roughly_flat() {
        let mut r = Rng::new(31337);
        let mut counts = [0usize; 7];
        for _ in 0..70_000 {
            let v = r.below(7) as usize;
            counts[v] += 1;
        }
        for (i, c) in counts.iter().enumerate() {
            let f = *c as f64 / 70_000.0;
            assert!((f - 1.0 / 7.0).abs() < 0.01, "value {i} fraction {f}");
        }
        assert_eq!(r.below(1), 0);
    }

    #[test]
    fn choice_and_shuffle_are_deterministic_permutations() {
        let items = [10, 20, 30, 40, 50];
        let mut r = Rng::new(2026);
        let picks: Vec<i32> = (0..20).map(|_| *r.choice(&items).unwrap()).collect();
        assert!(picks.iter().all(|p| items.contains(p)));
        let mut r2 = Rng::new(2026);
        let picks2: Vec<i32> = (0..20).map(|_| *r2.choice(&items).unwrap()).collect();
        assert_eq!(picks, picks2);

        let empty: [i32; 0] = [];
        assert!(r.choice(&empty).is_none());

        let mut a: Vec<i32> = (0..50).collect();
        let mut b = a.clone();
        let mut ra = Rng::new(777);
        let mut rb = Rng::new(777);
        ra.shuffle(&mut a);
        rb.shuffle(&mut b);
        assert_eq!(a, b, "shuffle must be deterministic");
        assert_ne!(a, (0..50).collect::<Vec<i32>>(), "shuffle must permute");
        let mut sorted = a.clone();
        sorted.sort_unstable();
        assert_eq!(
            sorted,
            (0..50).collect::<Vec<i32>>(),
            "shuffle must not lose elements"
        );

        // Degenerate sizes are no-ops.
        let mut one = [1];
        ra.shuffle(&mut one);
        assert_eq!(one, [1]);
        let mut none: [i32; 0] = [];
        ra.shuffle(&mut none);
    }
}
