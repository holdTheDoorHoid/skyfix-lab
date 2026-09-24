//! Deterministic seeded generator, local to this crate.
//!
//! No `rand` dependency: `rand` pulls in `getrandom`, which does not build for
//! `wasm32-unknown-unknown` without extra cfg flags, and a hand-written generator
//! guarantees a bit-identical stream on native and WASM. `skyfix-sim` carries its own
//! copy of the same construction for the same reason; the two are deliberately
//! independent so that a change to one cannot silently move the other's fixtures.
//!
//! - Seeding: **splitmix64** expands the 64-bit user seed into the 256-bit state, so
//!   even seeds 0, 1, 2 give well-separated streams.
//! - Stream: **xoshiro256\*\*** (Blackman & Vigna), period 2^256 - 1.
//! - Normals: **Box-Muller**, two deviates per pair of uniforms, the second cached.
//!
//! Every numeric output here is a regression surface: the tests pin the first values for
//! a fixed seed. Changing the algorithm changes every rendered image.

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

    /// Uniform in `[0, 1)`, from the top 53 bits. Never exactly 1.0.
    pub fn next_f64(&mut self) -> f64 {
        const SCALE: f64 = 1.0 / 9_007_199_254_740_992.0; // 2^-53
        (self.next_u64() >> 11) as f64 * SCALE
    }

    /// Uniform integer in `[0, n)`, unbiased by modulo rejection. Panics if `n == 0`.
    pub fn below(&mut self, n: u64) -> u64 {
        assert!(n > 0, "Rng::below requires n > 0");
        let threshold = (u64::MAX - n + 1) % n;
        loop {
            let x = self.next_u64();
            if x >= threshold {
                return x % n;
            }
        }
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

    /// Poisson deviate with mean `lambda`, used for photon shot noise.
    ///
    /// Knuth's product method below `POISSON_NORMAL_CUTOFF`, where it costs on average
    /// `lambda` uniforms; a rounded normal approximation above it, where Knuth would be
    /// both slow and numerically fragile (`exp(-lambda)` underflows past ~745). At
    /// `lambda = 30` the normal approximation's largest probability error is under
    /// 0.006, far below the read noise it sits next to, and a star's core pixels are in
    /// the thousands of counts where the approximation is excellent.
    pub fn poisson(&mut self, lambda: f64) -> f64 {
        const POISSON_NORMAL_CUTOFF: f64 = 30.0;
        if !(lambda > 0.0) {
            return 0.0;
        }
        if lambda >= POISSON_NORMAL_CUTOFF {
            return (lambda + lambda.sqrt() * self.normal()).round().max(0.0);
        }
        let limit = (-lambda).exp();
        let mut k = 0.0f64;
        let mut p = 1.0f64;
        loop {
            p *= self.next_f64();
            if p <= limit {
                return k;
            }
            k += 1.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the stream. These constants are a contract: if they change, every rendered
    /// image in this crate changed with them. They were checked against an independent
    /// reimplementation of splitmix64 + xoshiro256\*\* rather than recorded from this
    /// code, so the test can fail an implementation error and not only a change.
    #[test]
    fn stream_is_pinned_for_a_fixed_seed() {
        let mut r = Rng::new(20_261_001);
        let got: Vec<u64> = (0..4).map(|_| r.next_u64()).collect();
        assert_eq!(
            got,
            vec![
                18_320_308_228_391_176_053,
                10_410_876_581_987_912_450,
                2_588_568_368_001_374_660,
                5_788_299_160_709_731_014
            ],
            "xoshiro256** stream changed"
        );
    }

    #[test]
    fn same_seed_same_stream_different_seeds_differ() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        for _ in 0..64 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
        let mut c = Rng::new(8);
        let mut d = Rng::new(7);
        let differ = (0..100).filter(|_| c.next_u64() != d.next_u64()).count();
        assert!(differ > 95, "adjacent seeds produced a correlated stream");
        // A zero seed must not give a zero state (the xoshiro failure mode).
        assert_ne!(Rng::new(0).next_u64(), 0);
    }

    #[test]
    fn uniforms_are_in_range_and_normals_have_the_right_moments() {
        let mut r = Rng::new(42);
        let n = 200_000;
        let mut sum = 0.0;
        let mut sumsq = 0.0;
        for _ in 0..n {
            let u = r.next_f64();
            assert!((0.0..1.0).contains(&u));
            let z = r.normal();
            sum += z;
            sumsq += z * z;
        }
        let mean = sum / n as f64;
        let var = sumsq / n as f64 - mean * mean;
        // 1-sigma of the sample mean is 1/sqrt(n) = 0.0022; 4 sigma is 0.009.
        assert!(mean.abs() < 0.01, "normal mean {mean}");
        assert!((var - 1.0).abs() < 0.02, "normal variance {var}");
    }

    #[test]
    fn poisson_matches_its_mean_and_variance_on_both_branches() {
        for lambda in [4.0_f64, 400.0_f64] {
            let mut r = Rng::new(9 + lambda as u64);
            let n = 40_000;
            let mut sum = 0.0;
            let mut sumsq = 0.0;
            for _ in 0..n {
                let k = r.poisson(lambda);
                assert!(k >= 0.0);
                sum += k;
                sumsq += k * k;
            }
            let mean = sum / n as f64;
            let var = sumsq / n as f64 - mean * mean;
            let tol = 5.0 * (lambda / n as f64).sqrt();
            assert!((mean - lambda).abs() < tol, "lambda {lambda} mean {mean}");
            assert!(
                (var - lambda).abs() < 0.1 * lambda,
                "lambda {lambda} var {var}"
            );
        }
        assert_eq!(Rng::new(1).poisson(0.0), 0.0);
        assert_eq!(Rng::new(1).poisson(-3.0), 0.0);
    }

    #[test]
    fn below_is_in_range() {
        let mut r = Rng::new(5);
        for _ in 0..1000 {
            assert!(r.below(7) < 7);
        }
        assert_eq!(r.below(1), 0);
    }
}
