//! Deterministic pseudo-random generator for this crate's scenarios.
//!
//! Same construction as `skyfix_sim::rng` (splitmix64 seeding, xoshiro256\*\* stream,
//! Box-Muller normals with the second deviate cached), reproduced here rather than
//! depended on so that `skyfix-motion` keeps a single dependency (`skyfix-core`) and
//! builds for `wasm32-unknown-unknown` without pulling in the ephemeris crate. No `rand`
//! dependency: `getrandom` does not build for that target without extra cfg flags, and a
//! hand-written generator guarantees a bit-identical stream on native and WASM.
//!
//! The stream is a regression surface: the tests pin the first values for a fixed seed.
//! Changing the algorithm changes every scenario number in `docs/MOTION.md`.

/// splitmix64, used only to expand the seed into the 256-bit state.
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
    cached_normal: Option<f64>,
}

impl Rng {
    /// Seed the generator. The same seed always produces the same stream.
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

    /// Uniform in `[0, 1)`, from the top 53 bits.
    pub fn next_f64(&mut self) -> f64 {
        const SCALE: f64 = 1.0 / 9_007_199_254_740_992.0;
        (self.next_u64() >> 11) as f64 * SCALE
    }

    /// Standard normal deviate (Box-Muller, second value cached).
    pub fn normal(&mut self) -> f64 {
        if let Some(z) = self.cached_normal.take() {
            return z;
        }
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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned from `skyfix_sim::rng`: the two crates must produce the same stream from
    /// the same seed, so a scenario can be moved between them without renumbering.
    const SEED_12345_U64: [u64; 4] = [
        13_720_838_825_685_603_483,
        2_398_916_695_208_396_998,
        17_770_384_849_984_869_256,
        891_717_726_879_801_395,
    ];

    #[test]
    fn stream_matches_the_simulator_crate() {
        let mut r = Rng::new(12345);
        let got: Vec<u64> = (0..4).map(|_| r.next_u64()).collect();
        assert_eq!(got.as_slice(), &SEED_12345_U64);

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
    fn normals_have_the_right_first_two_moments() {
        let mut r = Rng::new(20_261_001);
        let n = 50_000;
        let (mut sum, mut sum2) = (0.0, 0.0);
        for _ in 0..n {
            let z = r.normal();
            sum += z;
            sum2 += z * z;
        }
        let nf = f64::from(n);
        let mean = sum / nf;
        let var = sum2 / nf - mean * mean;
        assert!(mean.abs() < 0.023, "normal mean {mean}");
        assert!((var - 1.0).abs() < 0.032, "normal variance {var}");
    }

    #[test]
    fn same_seed_same_stream_and_normal_with_scales() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        for _ in 0..200 {
            assert_eq!(a.normal(), b.normal());
        }
        assert_eq!(a, b);

        let mut r = Rng::new(5);
        let mut s = Rng::new(5);
        for _ in 0..50 {
            let z = s.normal();
            assert_eq!(r.normal_with(3.0, 2.0), 3.0 + 2.0 * z);
        }
    }
}
