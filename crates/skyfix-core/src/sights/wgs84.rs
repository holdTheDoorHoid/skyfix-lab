//! The observer on the WGS84 ellipsoid: the lunar-distance clearing, and the Moon's
//! Earth-shape term in every model altitude (CONVENTIONS sections 1 and 15.4).
//!
//! CONVENTIONS section 1 reduces sights on a sphere. The lunar distance is the one
//! navigation method here that needs the Moon's parallax to a few hundredths of an
//! arcminute, so its clearing places the observer on the ellipsoid, exactly as the
//! explorer's topocentric display does (`skyfix_ephemeris::topocentric`, validated
//! against Skyfield to 0.63"). The Earth-fixed frame has x through the Greenwich
//! meridian of date and z along the true pole of date; a body at apparent geocentric
//! GHA (west-positive) and declination points along `(cos d cos(-GHA), cos d sin(-GHA),
//! sin d)`. Polar motion and diurnal aberration (both under 0.5") are left out.
//!
//! [`EarthShape`] and [`earth_shape_arcmin`] carry the same geometry into sight reduction:
//! the part of the Moon's parallax the sphere leaves out, added to the model altitude
//! `Hc` of a Moon sight at the trial position (see [`EarthShape`]).

/// WGS84 equatorial radius, km.
pub const WGS84_A_KM: f64 = 6378.137;
/// WGS84 flattening.
pub const WGS84_F: f64 = 1.0 / 298.257_223_563;
/// The radius the providers' horizontal parallax refers to (IAU 1976, 6378.14 km): the
/// Moon's and the Sun's HP are exactly `asin(6378.14 km / d)`; the planets' use the
/// WGS84 6378.137 km, a difference of 5e-7 in the distance recovered from it.
pub const HP_RADIUS_KM: f64 = 6378.14;

pub type Vec3 = [f64; 3];

pub fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

pub fn scale(a: Vec3, k: f64) -> Vec3 {
    [a[0] * k, a[1] * k, a[2] * k]
}

pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub fn unit(a: Vec3) -> Vec3 {
    scale(a, 1.0 / norm(a))
}

/// Angle between two vectors, radians, robust at 0 and pi.
pub fn angle(a: Vec3, b: Vec3) -> f64 {
    norm(cross(a, b)).atan2(dot(a, b))
}

/// Earth-fixed unit vector of an apparent geocentric GHA/Dec (degrees).
pub fn earth_fixed_unit(gha_deg: f64, dec_deg: f64) -> Vec3 {
    let (g, d) = (gha_deg.to_radians(), dec_deg.to_radians());
    [d.cos() * g.cos(), -d.cos() * g.sin(), d.sin()]
}

/// A sea-level site on the ellipsoid: its Earth-fixed position (km) and the east,
/// north and up axes of its geodetic normal.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Site {
    pub position_km: Vec3,
    pub east: Vec3,
    pub north: Vec3,
    pub up: Vec3,
}

impl Site {
    pub fn new(lat_deg: f64, lon_deg: f64) -> Site {
        let (phi, lam) = (lat_deg.to_radians(), lon_deg.to_radians());
        let e2 = WGS84_F * (2.0 - WGS84_F);
        let n = WGS84_A_KM / (1.0 - e2 * phi.sin().powi(2)).sqrt();
        let (sp, cp) = phi.sin_cos();
        let (sl, cl) = lam.sin_cos();
        Site {
            position_km: [n * cp * cl, n * cp * sl, n * (1.0 - e2) * sp],
            east: [-sl, cl, 0.0],
            north: [-sp * cl, -sp * sl, cp],
            up: [cp * cl, cp * sl, sp],
        }
    }

    /// Earth-fixed vector to local (east, north, up).
    pub fn to_enu(&self, v: Vec3) -> Vec3 {
        [dot(v, self.east), dot(v, self.north), dot(v, self.up)]
    }

    /// Local (east, north, up) to Earth-fixed.
    pub fn from_enu(&self, v: Vec3) -> Vec3 {
        add(
            add(scale(self.east, v[0]), scale(self.north, v[1])),
            scale(self.up, v[2]),
        )
    }
}

/// Local unit vector (east, north, up) of an altitude and azimuth in degrees.
pub fn enu_from_alt_az(alt_deg: f64, az_deg: f64) -> Vec3 {
    let (a, z) = (alt_deg.to_radians(), az_deg.to_radians());
    [a.cos() * z.sin(), a.cos() * z.cos(), a.sin()]
}

/// Altitude and azimuth `[0, 360)` in degrees of a local (east, north, up) vector.
pub fn alt_az_from_enu(v: Vec3) -> (f64, f64) {
    let u = unit(v);
    (
        u[2].clamp(-1.0, 1.0).asin().to_degrees(),
        crate::units::norm_360(u[0].atan2(u[1]).to_degrees()),
    )
}

/// The distance along the unit direction `u` from the site at which a point is `d` km
/// from the Earth's centre: the positive root of `|o + s u| = d`.
pub fn range_to_radius(site: &Site, u: Vec3, d: f64) -> f64 {
    let o = site.position_km;
    let b = dot(o, u);
    let c = dot(o, o) - d * d;
    -b + (b * b - c).max(0.0).sqrt()
}

// ---------------------------------------------------------------------------
// The Moon's Earth-shape term (CONVENTIONS section 15.4; moonshape agent, expansion
// programme 2026-09-24)
// ---------------------------------------------------------------------------

/// First eccentricity squared of the WGS84 ellipsoid, `f (2 - f)`.
pub const WGS84_E2: f64 = WGS84_F * (2.0 - WGS84_F);

/// The Moon's Earth-shape term for one sight: the part of the Moon's parallax that the
/// sphere of CONVENTIONS section 1 leaves out, as an addition to the model altitude.
///
/// The correction chain (CONVENTIONS section 5 step 5) turns the observed topocentric
/// altitude `h` into the geocentric altitude of the sphere, `Ho = h + asin(sin HP cos h)`,
/// which is exact for an observer at the radius `HP` refers to. On the real Earth the
/// observer at geodetic latitude `phi` is nearer the centre than that radius, and the
/// plumb line (the ellipsoid normal, from which altitudes are measured) does not point
/// at the centre. A perfect Moon sight on the WGS84 Earth therefore reduces to
///
/// ```text
/// Ho = h_t + asin(sin HP cos h_t) = Hc_sphere + term
/// ```
///
/// where `h_t` is the true altitude of the Moon's centre above the geodetic horizon of a
/// sea-level site and `Hc_sphere` is CONVENTIONS section 3 at the same geodetic latitude
/// and longitude. The model altitude of a Moon sight is `Hc_sphere + term`, so `Ho` keeps
/// its meaning and 1' of altitude stays 1 NM (CONVENTIONS 15.4). To first order
/// `term = HP f (sin^2 phi cos h - sin 2phi sin h cos Z)` (f the flattening, `h` and `Z`
/// the altitude and azimuth the observer sees), which is minus the Nautical Almanac's
/// oblateness correction to `Ho` with the actual HP in place of its mean; it reaches
/// 0.238' (phi = 54.7 deg, the Moon on the meridian toward the equator at 55 deg, HP
/// 61.5'). The first-order form is 0.0002' out (0.004' if `h` is taken as the
/// geocentric altitude) and undefined at the zenith, so the exact geometry is used here.
///
/// The Moon is placed at `d = 6378.14 km / sin HP` along its apparent geocentric
/// direction (the radius the providers' HP refers to, [`HP_RADIUS_KM`]), `h_t` is the
/// altitude of `d u - o` (`o` the site on the ellipsoid) above the geodetic horizon, and
/// the altitudes are taken with `atan2`, so the term keeps full precision up to the
/// zenith. [`EarthShape::term_rad_from_components`] is that vector computation with the
/// dot products written out (`u . up = sin Hc_sphere`, `o . up = a^2 / N`,
/// `o . north = -N e^2 sin phi cos phi`, `o . east = 0`), the difference of the two
/// altitudes taken as one small angle and the small arcsine and arctangent by their
/// series, so the misfit grid can afford it at every node (about 30 ns).
/// [`earth_shape_arcmin`] does it with explicit vectors ([`Site`], [`earth_fixed_unit`])
/// and library `atan2`/`asin`, and is the reference the tests hold it to (1.5e-12').
///
/// Left out, and why: the observer's height above the sea (30 m changes the Moon's
/// parallax by 0.0003'), polar motion and the deflection of the vertical (ACCURACY.md
/// section 4). The
/// term is applied to the Moon only: with its HP of 0.55' at inferior conjunction Venus's
/// term is at most 0.0021', Mars's 0.0015' and the Sun's 0.0006' (the worst case scales
/// with HP, 0.00387' per arcminute), and the Nautical Almanac applies it to the Moon
/// alone.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EarthShape {
    sin_hp: f64,
    /// `sin HP / 6378.14 km`: the reciprocal of the Moon's geocentric distance, 1/km.
    inv_distance_km: f64,
}

impl EarthShape {
    /// The term for a body of horizontal parallax `hp_arcmin`. `None` unless the HP is
    /// finite, positive and below 90 degrees (a star, or a direction that does not say).
    pub fn new(hp_arcmin: f64) -> Option<EarthShape> {
        if !(hp_arcmin.is_finite() && hp_arcmin > 0.0 && hp_arcmin < 5400.0) {
            return None;
        }
        let sin_hp = (hp_arcmin / 60.0).to_radians().sin();
        Some(EarthShape {
            sin_hp,
            inv_distance_km: sin_hp / HP_RADIUS_KM,
        })
    }

    /// The term in radians, from the sine and cosine of the observer's geodetic latitude
    /// and the components of the body's apparent geocentric unit direction along the
    /// local up, north and east axes there (CONVENTIONS section 3: `up = sin Hc`,
    /// `north = cos(phi) sin(dec) - sin(phi) cos(dec) cos(LHA)`,
    /// `east = -cos(dec) sin(LHA)`).
    pub fn term_rad_from_components(
        &self,
        sin_lat: f64,
        cos_lat: f64,
        up: f64,
        north: f64,
        east: f64,
    ) -> f64 {
        self.term_rad_at_site(&SiteOffsets::new(sin_lat, cos_lat), up, north, east)
    }

    /// [`EarthShape::term_rad_from_components`] with the site's part computed once for its
    /// latitude (the misfit grid shares it along a row of nodes).
    #[inline]
    pub fn term_rad_at_site(&self, site: &SiteOffsets, up: f64, north: f64, east: f64) -> f64 {
        // v / d = u - o / d: the site vector along up (a^2 / N) and north (-N e^2 s c).
        let up_t = up - self.inv_distance_km * site.up_km;
        let north_t = north + self.inv_distance_km * site.north_km;
        // Plain square roots rather than `hypot`: every component is at most about 1,
        // so nothing can overflow, and the misfit grid evaluates this at every node.
        let horizontal = (north * north + east * east).sqrt();
        let horizontal_t = (north_t * north_t + east * east).sqrt();
        // h_t - Hc_sphere as one angle: the angle between the two (horizontal, up)
        // vectors, full precision up to the zenith. It is about the parallax, small.
        let h_t_minus_hc = atan2_small(
            up_t * horizontal - horizontal_t * up,
            horizontal_t * horizontal + up_t * up,
        );
        let cos_h_t = horizontal_t / (up_t * up_t + horizontal_t * horizontal_t).sqrt();
        h_t_minus_hc + asin_small(self.sin_hp * cos_h_t)
    }
    /// The term in radians for an observer at geodetic `lat`, east `lon` and a body at
    /// apparent geocentric `gha` (west-positive) and `dec`, all radians.
    pub fn term_rad(&self, lat: f64, lon: f64, gha: f64, dec: f64) -> f64 {
        let (sphi, cphi) = lat.sin_cos();
        let (sdec, cdec) = dec.sin_cos();
        let (slha, clha) = (gha + lon).sin_cos();
        self.term_rad_from_components(
            sphi,
            cphi,
            sphi * sdec + cphi * cdec * clha,
            cphi * sdec - sphi * cdec * clha,
            -cdec * slha,
        )
    }

    /// The term in arcminutes (see [`EarthShape::term_rad`]).
    pub fn term_arcmin(&self, lat: f64, lon: f64, gha: f64, dec: f64) -> f64 {
        crate::units::rad_to_arcmin(self.term_rad(lat, lon, gha, dec))
    }
}

/// The part of [`EarthShape`] that depends only on the site's geodetic latitude: the
/// sea-level site vector's components along the local up (`a^2 / N`) and north
/// (`-N e^2 sin phi cos phi`, stored with its sign flipped) axes, km.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SiteOffsets {
    up_km: f64,
    north_km: f64,
}

impl SiteOffsets {
    pub fn new(sin_lat: f64, cos_lat: f64) -> SiteOffsets {
        let w = (1.0 - WGS84_E2 * sin_lat * sin_lat).sqrt();
        SiteOffsets {
            up_km: WGS84_A_KM * w,
            north_km: (WGS84_A_KM / w) * WGS84_E2 * sin_lat * cos_lat,
        }
    }
}

/// `asin(x)` for the parallax's small argument (`|x| <= sin HP`, 0.018 for the Moon) by
/// its series to `x^9`, which is exact to rounding there (the next term is under 1e-18
/// below 0.03) and several times faster than `asin`; `asin` itself beyond 0.03.
#[inline]
fn asin_small(x: f64) -> f64 {
    if x.abs() > 0.03 {
        return x.clamp(-1.0, 1.0).asin();
    }
    let x2 = x * x;
    x * (1.0 + x2 * (1.0 / 6.0 + x2 * (3.0 / 40.0 + x2 * (5.0 / 112.0 + x2 * (35.0 / 1152.0)))))
}

/// `atan2(y, x)` for a small angle (`|y / x| <= 0.03` with `x > 0`: the difference of
/// the two altitudes, about the parallax) by the series of `atan(y / x)` to the ninth
/// power, exact to rounding there; `atan2` itself otherwise.
#[inline]
fn atan2_small(y: f64, x: f64) -> f64 {
    let z = y / x;
    if !(x > 0.0 && z.abs() <= 0.03) {
        return y.atan2(x);
    }
    let z2 = z * z;
    z * (1.0 - z2 * (1.0 / 3.0 - z2 * (1.0 / 5.0 - z2 * (1.0 / 7.0 - z2 * (1.0 / 9.0)))))
}

/// The Moon's Earth-shape term (CONVENTIONS 15.4), arcminutes, for an observer at
/// geodetic `lat_deg`, east `lon_deg` and the Moon at apparent geocentric `gha_deg`,
/// `dec_deg` with horizontal parallax `hp_arcmin`: `[h_t + asin(sin HP cos h_t)] -
/// Hc_sphere`, see [`EarthShape`]. Computed with explicit vectors on the ellipsoid; 0 when
/// the HP is not positive (no distance, no term).
pub fn earth_shape_arcmin(
    lat_deg: f64,
    lon_deg: f64,
    gha_deg: f64,
    dec_deg: f64,
    hp_arcmin: f64,
) -> f64 {
    let Some(shape) = EarthShape::new(hp_arcmin) else {
        return 0.0;
    };
    let site = Site::new(lat_deg, lon_deg);
    let u = earth_fixed_unit(gha_deg, dec_deg);
    let d_km = HP_RADIUS_KM / shape.sin_hp;
    let seen = site.to_enu(sub(scale(u, d_km), site.position_km));
    let geocentric = site.to_enu(u);
    let altitude = |v: Vec3| v[2].atan2(v[0].hypot(v[1]));
    let h_t = altitude(seen);
    let parallax = (shape.sin_hp * h_t.cos()).clamp(-1.0, 1.0).asin();
    ((h_t - altitude(geocentric)) + parallax).to_degrees() * 60.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_site_axes_are_orthonormal_and_up_is_the_geodetic_normal() {
        let s = Site::new(45.0, -75.0);
        for (a, b) in [(s.east, s.north), (s.north, s.up), (s.up, s.east)] {
            assert!(dot(a, b).abs() < 1e-15);
        }
        for a in [s.east, s.north, s.up] {
            assert!((norm(a) - 1.0).abs() < 1e-15);
        }
        // At 45 degrees the geocentric radius tilts 11.5' toward the equator from up.
        let tilt = angle(s.position_km, s.up).to_degrees() * 60.0;
        assert!((tilt - 11.5).abs() < 0.2, "{tilt}");
        assert!(norm(s.position_km) < WGS84_A_KM);
    }

    #[test]
    fn range_to_radius_lands_on_the_sphere_of_that_radius() {
        let s = Site::new(-33.0, 151.0);
        let u = unit(add(s.up, s.east));
        let r = range_to_radius(&s, u, 384_400.0);
        let p = add(s.position_km, scale(u, r));
        assert!((norm(p) - 384_400.0).abs() < 1e-6);
    }

    #[test]
    fn enu_round_trips_through_altitude_and_azimuth() {
        let v = enu_from_alt_az(23.4, 301.2);
        let (a, z) = alt_az_from_enu(v);
        assert!((a - 23.4).abs() < 1e-12 && (z - 301.2).abs() < 1e-12);
    }

    // --- the Moon's Earth-shape term (CONVENTIONS 15.4) ----------------------------

    /// A small deterministic generator (the workspace has no `rand`).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
        fn range(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (hi - lo) * self.next()
        }
    }

    /// The apparent geocentric GHA and Dec (degrees) of a direction with spherical
    /// altitude `h_deg` and azimuth `z_deg` at geodetic `lat_deg`, `lon_deg`.
    fn direction_at(lat_deg: f64, lon_deg: f64, h_deg: f64, z_deg: f64) -> (f64, f64) {
        let u = Site::new(lat_deg, lon_deg).from_enu(enu_from_alt_az(h_deg, z_deg));
        let dec = u[2].clamp(-1.0, 1.0).asin().to_degrees();
        let gha = crate::units::norm_360((-u[1]).atan2(u[0]).to_degrees());
        (gha, dec)
    }

    /// The apparent geocentric GHA and Dec (degrees) of a body of horizontal parallax
    /// `hp_arcmin` that an observer at the sea-level site sees at topocentric altitude
    /// `h_deg` and azimuth `z_deg`: the Moon placed on that line at its geocentric
    /// distance ([`range_to_radius`]), as the audit and `lunar.rs` do.
    fn direction_seen_at(
        lat_deg: f64,
        lon_deg: f64,
        h_deg: f64,
        z_deg: f64,
        hp_arcmin: f64,
    ) -> (f64, f64) {
        let site = Site::new(lat_deg, lon_deg);
        let tau = site.from_enu(enu_from_alt_az(h_deg, z_deg));
        let d = HP_RADIUS_KM / (hp_arcmin / 60.0).to_radians().sin();
        let u = unit(add(
            site.position_km,
            scale(tau, range_to_radius(&site, tau, d)),
        ));
        let dec = u[2].clamp(-1.0, 1.0).asin().to_degrees();
        let gha = crate::units::norm_360((-u[1]).atan2(u[0]).to_degrees());
        (gha, dec)
    }

    /// The first-order form, arcminutes: `HP f (sin^2 phi cos h - sin 2phi sin h cos Z)`.
    fn first_order(lat_deg: f64, h_deg: f64, z_deg: f64, hp_arcmin: f64) -> f64 {
        let (p, h, z) = (lat_deg.to_radians(), h_deg.to_radians(), z_deg.to_radians());
        hp_arcmin * WGS84_F * (p.sin().powi(2) * h.cos() - (2.0 * p).sin() * h.sin() * z.cos())
    }

    #[test]
    fn the_component_form_is_the_vector_form() {
        let mut g = Lcg(20_260_924);
        let mut worst = 0.0f64;
        for i in 0..20_000 {
            let lat = g.range(-89.9, 89.9);
            let lon = g.range(-180.0, 180.0);
            // Every tenth case within a degree of the zenith, where asin would lose
            // precision and the azimuth is undefined.
            let h = if i % 10 == 0 {
                g.range(89.0, 90.0)
            } else {
                g.range(-2.0, 89.0)
            };
            let z = g.range(0.0, 360.0);
            let hp = g.range(53.9, 61.5);
            let (gha, dec) = direction_at(lat, lon, h, z);
            let vector = earth_shape_arcmin(lat, lon, gha, dec, hp);
            let fast = EarthShape::new(hp).unwrap().term_arcmin(
                lat.to_radians(),
                lon.to_radians(),
                gha.to_radians(),
                dec.to_radians(),
            );
            worst = worst.max((vector - fast).abs());
        }
        println!("component form vs vector form: worst {worst:.2e}'");
        assert!(worst < 1e-9, "{worst:e}'");
    }

    #[test]
    fn the_first_order_formula_agrees_away_from_the_zenith() {
        // The audit's check (audit-accuracy.md 2.3): with the altitude and azimuth the
        // observer sees (the Moon placed on its topocentric direction at its distance,
        // `range_to_radius`), the Almanac-style formula matches the exact geometry to
        // 0.0002' except near the zenith. With the geocentric altitude in its place
        // instead it is 0.004' out: the formula's `h` is the observed one.
        let mut worst = 0.0f64;
        for lat in (-88..=88).step_by(4) {
            for h in (0..=84).step_by(4) {
                for z in (0..360).step_by(15) {
                    let (lat, h, z) = (lat as f64, h as f64, z as f64);
                    let (gha, dec) = direction_seen_at(lat, 0.0, h, z, 61.5);
                    let exact = earth_shape_arcmin(lat, 0.0, gha, dec, 61.5);
                    worst = worst.max((exact - first_order(lat, h, z, 61.5)).abs());
                }
            }
        }
        println!("first-order formula vs exact, HP 61.5', h <= 84 deg: worst {worst:.5}'");
        assert!(worst < 0.0003, "{worst}'");
    }

    #[test]
    fn the_worst_case_is_a_quarter_arcminute_at_54_7_degrees() {
        // max over h and Z of (sin^2 phi cos h + |sin 2phi| sin h) is 2/sqrt(3) at
        // sin^2 phi = 2/3: 0.238' at HP 61.5', the Moon on the meridian toward the
        // equator at about 55 deg.
        let mut worst = (0.0f64, 0.0, 0.0, 0.0);
        for lat10 in 0..=900 {
            let lat = lat10 as f64 / 10.0;
            if lat.fract() != 0.0 && !(50.0..=60.0).contains(&lat) {
                continue;
            }
            for h in 0..=89 {
                for z in [0.0, 90.0, 180.0, 270.0] {
                    let (gha, dec) = direction_at(lat, 0.0, h as f64, z);
                    let t = earth_shape_arcmin(lat, 0.0, gha, dec, 61.5);
                    if t.abs() > worst.0 {
                        worst = (t.abs(), lat, h as f64, z);
                    }
                }
            }
        }
        println!(
            "worst term {:.4}' at lat {} h {} Z {}",
            worst.0, worst.1, worst.2, worst.3
        );
        assert!((0.235..0.240).contains(&worst.0), "{worst:?}");
        assert!((53.0..57.0).contains(&worst.1), "{worst:?}");
        assert_eq!(worst.3, 180.0, "toward the equator: {worst:?}");
        // The sign. The geocentric vertical leans toward the equator from the plumb
        // line, so a Moon high toward the equator is nearer the geocentric zenith than
        // its altitude says and its true parallax is smaller than the sphere's: the chain
        // over-corrects, Ho comes out high, and the model altitude must rise with it.
        let (gha, dec) = direction_at(54.7, 0.0, 55.0, 180.0);
        assert!(earth_shape_arcmin(54.7, 0.0, gha, dec, 61.5) > 0.23);
        // Toward the pole and high the lean works the other way.
        let (gha, dec) = direction_at(54.7, 0.0, 55.0, 0.0);
        assert!(earth_shape_arcmin(54.7, 0.0, gha, dec, 61.5) < -0.07);
    }

    #[test]
    fn the_term_vanishes_on_the_equator_and_is_the_radius_alone_at_the_pole() {
        for (h, z) in [(0.0, 0.0), (30.0, 90.0), (60.0, 180.0), (85.0, 270.0)] {
            let (gha, dec) = direction_at(0.0, 10.0, h, z);
            // The equatorial radius is 6378.137 km, 3 m inside the HP radius.
            assert!(earth_shape_arcmin(0.0, 10.0, gha, dec, 61.0).abs() < 1e-4);
        }
        // At the pole the site is b = a (1 - f) from the centre, straight up the axis,
        // so the true parallax is exactly asin((b / d) cos h_t) and the term is what the
        // sphere adds on top of it: about HP f cos h_t.
        let sin_hp = (57.0f64 / 60.0).to_radians().sin();
        let d = HP_RADIUS_KM / sin_hp;
        let b = WGS84_A_KM * (1.0 - WGS84_F);
        for h_t in [0.0f64, 20.0, 45.0, 70.0] {
            let (gha, dec) = direction_seen_at(90.0, 0.0, h_t, 180.0, 57.0);
            let t = earth_shape_arcmin(90.0, 0.0, gha, dec, 57.0);
            let c = h_t.to_radians().cos();
            let expected = ((sin_hp * c).asin() - (b / d * c).asin()).to_degrees() * 60.0;
            assert!((t - expected).abs() < 1e-9, "h {h_t}: {t} vs {expected}");
            let rough = 57.0 * WGS84_F * c;
            assert!((t - rough).abs() < 2e-4, "h {h_t}: {t} vs {rough}");
        }
    }

    #[test]
    fn venus_mars_and_the_sun_are_left_out_because_their_term_is_tiny() {
        // CONVENTIONS 15.4: not applied to them. The worst case scales with HP.
        for (body, hp, bound) in [
            ("Venus at inferior conjunction", 0.554, 0.0022),
            ("Mars at a perihelic opposition", 0.394, 0.0016),
            ("the Sun at perihelion", 0.1494, 0.0006),
        ] {
            let mut worst = 0.0f64;
            for lat in (0..=90).step_by(2) {
                for h in (0..=89).step_by(1) {
                    for z in [0.0, 180.0] {
                        let (gha, dec) = direction_at(lat as f64, 0.0, h as f64, z);
                        worst = worst.max(earth_shape_arcmin(lat as f64, 0.0, gha, dec, hp).abs());
                    }
                }
            }
            println!("{body}: HP {hp}' -> worst Earth-shape term {worst:.5}'");
            assert!(worst < bound, "{body}: {worst}");
        }
    }

    #[test]
    fn an_independent_computation_gives_the_same_term() {
        // The same geometry written out again in Python (double precision, explicit
        // vectors, no code shared with this module), 2026-09-24.
        for (lat, lon, gha, dec, hp, want) in [
            (54.7, 0.0, 0.0, 0.0, 61.5, 0.22332381215033395),
            (
                39.9526,
                -75.1652,
                352.0833,
                26.305,
                59.341,
                0.05668299809180458,
            ),
            (-33.9, 151.2, 200.0, -20.0, 55.0, 0.15560159358638626),
            (12.0, -40.0, 80.0, 5.0, 57.3, 0.01216113580316577),
        ] {
            let got = earth_shape_arcmin(lat, lon, gha, dec, hp);
            assert!((got - want).abs() < 1e-11, "{lat} {lon}: {got} vs {want}");
        }
    }

    #[test]
    fn the_small_angle_arcsine_is_the_arcsine() {
        for k in 0..=2000 {
            let x = -0.06 + 0.12 * k as f64 / 2000.0;
            let diff = (asin_small(x) - x.asin()).abs();
            assert!(diff < 4e-18 + 1e-16 * x.abs(), "{x}: {diff:e}");
        }
    }

    #[test]
    fn the_small_angle_arctangent_is_the_arctangent() {
        for k in 0..=2000 {
            let z = -0.06 + 0.12 * k as f64 / 2000.0;
            for x in [0.97, 1.0, 1.02] {
                let y = z * x;
                let diff = (atan2_small(y, x) - y.atan2(x)).abs();
                assert!(diff < 1e-16 * (1.0 + y.abs()), "{y} {x}: {diff:e}");
            }
        }
        // Outside the small-angle range it is atan2 itself.
        assert_eq!(atan2_small(1.0, -1.0), 1.0f64.atan2(-1.0));
    }

    #[test]
    fn no_parallax_no_term() {
        assert!(EarthShape::new(0.0).is_none());
        assert!(EarthShape::new(-1.0).is_none());
        assert!(EarthShape::new(f64::NAN).is_none());
        assert_eq!(earth_shape_arcmin(45.0, 0.0, 10.0, 20.0, 0.0), 0.0);
        assert!(EarthShape::new(59.0).is_some());
    }
}
