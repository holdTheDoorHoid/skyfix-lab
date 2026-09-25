//! The disc of a planet as a telescope shows it: apparent diameters, phase and the
//! defect of illumination, the position angles of the bright limb and of the north
//! pole, the sub-Earth and sub-solar points and the central-meridian longitudes.
//!
//! OWNER: planetdetail agent (expansion programme P9). CONVENTIONS 13.13; wire format
//! `docs/EXPLORER_API.md`, "Planet detail"; accuracy `docs/ACCURACY.md`, "Planet
//! detail".
//!
//! # Model
//!
//! The planet's apparent place, distance, light-time, phase angle and bright-limb angle
//! come from [`skyfix_ephemeris::planets::PlanetProvider`] (VSOP87A, the explorer's own
//! planet pipeline). The geometry of the disc follows the IAU WGCCRE 2015 rotation
//! elements ([`crate::planet_geometry::orientation`]):
//!
//! - **Sub-Earth point**: the planetocentric latitude and longitude of the direction from
//!   the planet's centre (at the light-time instant) to the Earth's centre, geometric (no
//!   aberration), with the rotation evaluated at the instant the light left the
//!   sub-Earth surface point, `t - (delta - R_eq) / c`. That is JPL Horizons' convention
//!   (measured: without the `R_eq / c` the longitudes of Jupiter and Saturn sit a
//!   constant 8.7" and 6.8" behind Horizons').
//! - **Sub-solar point**: the same for the direction of the Sun as the planet sees it,
//!   with the aberration of the planet's own orbital velocity (up to 9" for Jupiter),
//!   which is where the Sun stands overhead (Horizons again; Meeus chapter 45 makes the
//!   same correction for Saturn's rings).
//! - **Latitudes** are given planetocentric (the angle at the centre) and planetographic
//!   (the angle of the surface normal on the IAU reference ellipsoid,
//!   `tan phi_g = tan phi_c / (1 - f)^2`), the latter being what Horizons prints.
//! - **Longitudes** follow the IAU planetographic convention: west-positive for the
//!   direct rotators (the central meridian increases with time), east-positive for
//!   Venus and Uranus. The central meridian *is* the sub-Earth longitude. Jupiter has
//!   three: System I (877.900 deg/day, the equatorial belt), System II (870.270 deg/day,
//!   the rest of the visible disc) and System III (870.536 deg/day, the magnetic field
//!   and the IAU prime meridian); Saturn's is System III.
//! - **Pole position angle**: the IAU pole moved to the true equator of date, projected
//!   on the sky at the planet's apparent direction, from north through east.
//! - **Diameters**: equatorial `2 asin(R_eq / delta)`; polar as the apparent outline's
//!   minor axis, `equatorial * sqrt(1 - e^2 cos^2 B)`, `e^2 = 1 - (R_pol / R_eq)^2`, `B`
//!   the planetocentric sub-Earth latitude.
//! - **Defect of illumination**: `(1 - k) * equatorial diameter`, `k` the illuminated
//!   fraction (Meeus chapter 41; Horizons' `Def_illu`).
//!
//! **The Great Red Spot is not tracked.** It drifts in System II longitude by tens of
//! degrees a year, irregularly (about 2 deg a month in 2024-2026); a longitude compiled
//! into the site would be wrong within months, and a current one needs observations the
//! site cannot fetch offline. The UI can accept a longitude the user enters.

use serde::{Deserialize, Serialize};
use skyfix_core::time::format_utc;
use skyfix_ephemeris::planets::{Planet, PlanetPosition, PlanetProvider, heliocentric_position_au};

use crate::planet_geometry::{
    C_AU_PER_DAY, JupiterSystem, Orientation, Vec3, add, axis_position_angle_deg, flattening,
    icrs_to_true_of_date, jupiter_w_deg, longitude_positive_west, mat_vec, orientation,
    polar_radius_km, radec_unit, scale, sub, unavailable, unit,
};
use crate::sky::AlmanacError;

/// Kilometres per astronomical unit.
const AU_KM: f64 = skyfix_ephemeris::body::AU_KM;

/// One central-meridian longitude.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CentralMeridian {
    /// `"I"`, `"II"`, `"III"` (Jupiter; Saturn and Uranus use System III) or `"IAU"`.
    pub system: String,
    /// Degrees `[0, 360)`, counted as `longitude_positive` says.
    pub longitude_deg: f64,
}

/// The planet's disc at one instant (EXPLORER_API.md `PlanetDisc`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanetDisc {
    pub body: String,
    pub jd_utc: f64,
    pub utc: String,
    /// Light-time distance from the Earth's centre.
    pub distance_au: f64,
    pub light_time_s: f64,
    pub equatorial_diameter_arcsec: f64,
    pub polar_diameter_arcsec: f64,
    pub phase_angle_deg: f64,
    pub illuminated_fraction: f64,
    /// The width of the dark part along the diameter through the bright limb.
    pub defect_of_illumination_arcsec: f64,
    /// Position angle of the bright limb's midpoint, north through east.
    pub bright_limb_angle_deg: f64,
    /// Position angle of the planet's north pole (IAU), north through east.
    pub pole_position_angle_deg: f64,
    /// Planetocentric latitude of the Earth seen from the planet.
    pub sub_earth_lat_deg: f64,
    /// The same, planetographic (on the IAU reference ellipsoid).
    pub sub_earth_lat_graphic_deg: f64,
    /// Longitude of the sub-Earth point in the IAU system (for Jupiter System III).
    pub sub_earth_lon_deg: f64,
    pub sub_solar_lat_deg: f64,
    pub sub_solar_lat_graphic_deg: f64,
    pub sub_solar_lon_deg: f64,
    /// `"west"` or `"east"`: the IAU planetographic sense of every longitude here.
    pub longitude_positive: String,
    /// The central meridians: Jupiter I, II, III; Saturn and Uranus III; others IAU.
    pub central_meridians: Vec<CentralMeridian>,
    pub magnitude: Option<f64>,
    pub rotation_model: String,
    pub notes: Vec<String>,
}

/// The vectors the disc and ring geometry need, from one provider evaluation.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PlanetView {
    pub(crate) position: PlanetPosition,
    /// Earth to planet, astrometric (light-time corrected, no aberration), ICRS, au.
    pub(crate) astrometric: Vec3,
    /// Direction from the planet to the Sun as the planet sees it: the aberration of its
    /// own heliocentric velocity applied (up to 9" for Jupiter, 23" for Mercury), which is
    /// where the Sun stands overhead. Unit vector, ICRS.
    pub(crate) sun_apparent_from_planet: Vec3,
    /// The planet's orientation at the instant the light left its sub-Earth point.
    pub(crate) orientation: Orientation,
    /// TT Julian date of that instant.
    pub(crate) jd_tdb_rotation: f64,
}

pub(crate) fn planet_view(
    provider: &PlanetProvider,
    planet: Planet,
    jd_utc: f64,
) -> Result<PlanetView, AlmanacError> {
    let position = provider
        .position(planet, jd_utc)
        .map_err(|e| unavailable(planet.name(), e))?;
    let tau = position.light_time_s / 86_400.0;
    let earth =
        heliocentric_position_au("Earth", position.jd_tt).map_err(|e| unavailable("Earth", e))?;
    let heliocentric = heliocentric_position_au(planet.name(), position.jd_tt - tau)
        .map_err(|e| unavailable(planet.name(), e))?;
    let astrometric = sub(heliocentric, earth);
    // The planet's heliocentric velocity by a central difference over two hours: the
    // aberration it causes is under 25", so a 1e-6 relative velocity error is nothing.
    let h = 1.0 / 24.0;
    let ahead = heliocentric_position_au(planet.name(), position.jd_tt - tau + h)
        .map_err(|e| unavailable(planet.name(), e))?;
    let behind = heliocentric_position_au(planet.name(), position.jd_tt - tau - h)
        .map_err(|e| unavailable(planet.name(), e))?;
    let velocity_c = scale(sub(ahead, behind), 1.0 / (2.0 * h * C_AU_PER_DAY));
    let sun_apparent_from_planet = unit(add(unit(scale(heliocentric, -1.0)), velocity_c));
    let r_eq_au = planet.equatorial_radius_km() / AU_KM;
    let jd_tdb_rotation = position.jd_tt - tau + r_eq_au / C_AU_PER_DAY;
    Ok(PlanetView {
        position,
        astrometric,
        sun_apparent_from_planet,
        orientation: orientation(planet, jd_tdb_rotation),
        jd_tdb_rotation,
    })
}

/// Planetographic latitude from planetocentric, degrees.
pub(crate) fn graphic_latitude_deg(planet: Planet, lat_centric_deg: f64) -> f64 {
    let k = (1.0 - flattening(planet)).powi(2);
    (lat_centric_deg.to_radians().tan() / k).atan().to_degrees()
}

fn displayed_longitude(planet: Planet, lon_east_deg: f64) -> f64 {
    if longitude_positive_west(planet) {
        (360.0 - lon_east_deg).rem_euclid(360.0)
    } else {
        lon_east_deg.rem_euclid(360.0)
    }
}

/// The disc of `planet` at `jd_utc`.
pub fn planet_disc(
    provider: &PlanetProvider,
    planet: Planet,
    jd_utc: f64,
) -> Result<PlanetDisc, AlmanacError> {
    let v = planet_view(provider, planet, jd_utc)?;
    let p = &v.position;
    let o = &v.orientation;
    let (sub_lat, sub_lon_e) = o.lat_lon_east_deg(scale(v.astrometric, -1.0));
    let (sun_lat, sun_lon_e) = o.lat_lon_east_deg(v.sun_apparent_from_planet);
    let delta_km = p.distance_au * AU_KM;
    let a = planet.equatorial_radius_km();
    let eq_arcsec = 2.0 * (a / delta_km).asin().to_degrees() * 3600.0;
    let e2 = 1.0 - (polar_radius_km(planet) / a).powi(2);
    let polar_arcsec = eq_arcsec * (1.0 - e2 * sub_lat.to_radians().cos().powi(2)).sqrt();
    let pole_date = mat_vec(&icrs_to_true_of_date(p.jd_tt), o.pole);
    let pole_pa = axis_position_angle_deg(radec_unit(p.ra_deg, p.dec_deg), pole_date);

    let mut central_meridians = Vec::new();
    let mut notes = Vec::new();
    match planet {
        Planet::Jupiter => {
            for (sys, name) in [
                (JupiterSystem::I, "I"),
                (JupiterSystem::II, "II"),
                (JupiterSystem::III, "III"),
            ] {
                let oj = Orientation {
                    w_deg: jupiter_w_deg(sys, v.jd_tdb_rotation),
                    ..*o
                };
                let (_, lon_e) = oj.lat_lon_east_deg(scale(v.astrometric, -1.0));
                central_meridians.push(CentralMeridian {
                    system: name.to_string(),
                    longitude_deg: displayed_longitude(planet, lon_e),
                });
            }
            notes.push(
                "The Great Red Spot is not tracked: its System II longitude drifts by tens of \
                 degrees a year, irregularly, so no longitude compiled into the site stays \
                 right for more than a few months."
                    .to_string(),
            );
        }
        Planet::Saturn | Planet::Uranus => central_meridians.push(CentralMeridian {
            system: "III".to_string(),
            longitude_deg: displayed_longitude(planet, sub_lon_e),
        }),
        _ => central_meridians.push(CentralMeridian {
            system: "IAU".to_string(),
            longitude_deg: displayed_longitude(planet, sub_lon_e),
        }),
    }
    match planet {
        Planet::Venus => notes.push(
            "Venus's surface is hidden by clouds; its longitudes are those of the IAU \
             surface grid, not of anything seen."
                .to_string(),
        ),
        Planet::Uranus | Planet::Neptune => notes.push(
            "No surface detail is visible in amateur telescopes; the longitudes are the \
             IAU system's."
                .to_string(),
        ),
        _ => {}
    }

    Ok(PlanetDisc {
        body: planet.name().to_string(),
        jd_utc,
        utc: format_utc(jd_utc),
        distance_au: p.distance_au,
        light_time_s: p.light_time_s,
        equatorial_diameter_arcsec: eq_arcsec,
        polar_diameter_arcsec: polar_arcsec,
        phase_angle_deg: p.phase_angle_deg,
        illuminated_fraction: p.illuminated_fraction,
        defect_of_illumination_arcsec: (1.0 - p.illuminated_fraction) * eq_arcsec,
        bright_limb_angle_deg: p.bright_limb_angle_deg,
        pole_position_angle_deg: pole_pa,
        sub_earth_lat_deg: sub_lat,
        sub_earth_lat_graphic_deg: graphic_latitude_deg(planet, sub_lat),
        sub_earth_lon_deg: displayed_longitude(planet, sub_lon_e),
        sub_solar_lat_deg: sun_lat,
        sub_solar_lat_graphic_deg: graphic_latitude_deg(planet, sun_lat),
        sub_solar_lon_deg: displayed_longitude(planet, sun_lon_e),
        longitude_positive: if longitude_positive_west(planet) {
            "west"
        } else {
            "east"
        }
        .to_string(),
        central_meridians,
        magnitude: p.magnitude,
        rotation_model: "IAU WGCCRE 2015 (Archinal et al. 2018); Jupiter Systems I and II \
                         IAU 1976"
            .to_string(),
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::civil_to_jd;

    #[test]
    fn jupiter_has_three_central_meridians_and_a_red_spot_note() {
        let d = planet_disc(
            &PlanetProvider::new(),
            Planet::Jupiter,
            civil_to_jd(2026, 1, 10),
        )
        .unwrap();
        let systems: Vec<&str> = d
            .central_meridians
            .iter()
            .map(|c| c.system.as_str())
            .collect();
        assert_eq!(systems, ["I", "II", "III"]);
        assert_eq!(d.longitude_positive, "west");
        assert!((d.central_meridians[2].longitude_deg - d.sub_earth_lon_deg).abs() < 1e-9);
        assert!(d.notes.iter().any(|n| n.contains("Great Red Spot")));
        // Jupiter's disc near opposition: about 46.6" by 43.6".
        assert!(
            (46.0..47.5).contains(&d.equatorial_diameter_arcsec),
            "{d:?}"
        );
        assert!(d.polar_diameter_arcsec < d.equatorial_diameter_arcsec);
        assert!(d.defect_of_illumination_arcsec >= 0.0);
    }

    #[test]
    fn venus_and_uranus_count_longitude_east() {
        let p = PlanetProvider::new();
        for planet in [Planet::Venus, Planet::Uranus] {
            let d = planet_disc(&p, planet, civil_to_jd(2025, 1, 1)).unwrap();
            assert_eq!(d.longitude_positive, "east", "{planet:?}");
        }
    }
}
