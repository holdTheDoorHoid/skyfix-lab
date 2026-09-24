//! Deterministic seeded random numbers.
//!
//! splitmix64 for the uniform stream, Box-Muller for the normal stream. Written
//! out here rather than pulled in so the crate keeps zero extra dependencies and
//! builds for `wasm32-unknown-unknown`. Every experiment in this crate is
//! reproducible from its seed alone; nothing reads a clock or an OS entropy
//! source.

/// splitmix64 + Box-Muller. Clone the generator to fork a reproducible stream.
#[derive(Debug, Clone)]
pub struct Rng {
    state: u64,
    spare: Option<f64>,
}

impl Rng {
    /// Seed the generator. Any `u64` is a valid seed, including 0.
    pub fn new(seed: u64) -> Self {
        Rng {
            state: seed,
            spare: None,
        }
    }

    /// Raw splitmix64 step.
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, 1)` with 53 bits of mantissa.
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / 9_007_199_254_740_992.0)
    }

    /// Standard normal, mean 0 and variance 1 (Box-Muller, cached pair).
    pub fn normal(&mut self) -> f64 {
        if let Some(v) = self.spare.take() {
            return v;
        }
        // 1 - u avoids log(0); u is in (0, 1].
        let u1 = 1.0 - self.next_f64();
        let u2 = self.next_f64();
        let r = (-2.0 * u1.ln()).sqrt();
        let (s, c) = (std::f64::consts::TAU * u2).sin_cos();
        self.spare = Some(r * s);
        r * c
    }

    /// Normal with the given standard deviation. `sigma <= 0` returns exactly 0
    /// *and draws nothing*, so turning noise off does not shift the stream that
    /// later degradations see.
    pub fn normal_sigma(&mut self, sigma: f64) -> f64 {
        if sigma <= 0.0 {
            0.0
        } else {
            sigma * self.normal()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_gives_the_same_stream() {
        let a: Vec<u64> = (0..8).map(|_| Rng::new(42).next_u64()).collect();
        assert!(a.iter().all(|x| *x == a[0]));
        let mut r1 = Rng::new(7);
        let mut r2 = Rng::new(7);
        for _ in 0..64 {
            assert_eq!(r1.next_u64(), r2.next_u64());
            assert_eq!(r1.normal().to_bits(), r2.normal().to_bits());
        }
        // Different seeds diverge immediately.
        assert_ne!(Rng::new(7).next_u64(), Rng::new(8).next_u64());
    }

    #[test]
    fn uniforms_stay_in_range_and_look_uniform() {
        let mut r = Rng::new(0xDEAD_BEEF);
        let n = 200_000;
        let mut sum = 0.0;
        let mut bins = [0usize; 10];
        for _ in 0..n {
            let u = r.next_f64();
            assert!((0.0..1.0).contains(&u));
            sum += u;
            bins[(u * 10.0) as usize] += 1;
        }
        // Mean of U(0,1) is 0.5; sigma of the mean over 2e5 draws is 6.5e-4.
        assert!(
            (sum / n as f64 - 0.5).abs() < 0.005,
            "mean {}",
            sum / n as f64
        );
        for b in bins {
            let f = b as f64 / n as f64;
            assert!((f - 0.1).abs() < 0.01, "bin fraction {f}");
        }
    }

    #[test]
    fn normals_have_unit_variance_and_zero_mean() {
        let mut r = Rng::new(12345);
        let n = 200_000;
        let (mut s1, mut s2, mut s4) = (0.0, 0.0, 0.0);
        for _ in 0..n {
            let x = r.normal();
            s1 += x;
            s2 += x * x;
            s4 += x * x * x * x;
        }
        let mean = s1 / n as f64;
        let var = s2 / n as f64 - mean * mean;
        let kurt = (s4 / n as f64) / (var * var);
        // sigma of the mean is 1/sqrt(2e5) = 2.2e-3; allow 4 sigma.
        assert!(mean.abs() < 0.01, "mean {mean}");
        assert!((var - 1.0).abs() < 0.02, "var {var}");
        // Gaussian kurtosis is 3.
        assert!((kurt - 3.0).abs() < 0.15, "kurtosis {kurt}");
    }

    #[test]
    fn zero_sigma_draws_nothing() {
        let mut r = Rng::new(9);
        assert_eq!(r.normal_sigma(0.0), 0.0);
        let mut s = Rng::new(9);
        assert_eq!(r.next_u64(), s.next_u64());
    }
}
