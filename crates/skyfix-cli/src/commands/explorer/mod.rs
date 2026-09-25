//! The commands that give the command line the explorer's engine. OWNER: cli agent.
//!
//! The explorer redesign added sky state, almanac events, the navigation methods and
//! Moon and planet sights to the engine, and the browser reaches them through WASM
//! (docs/EXPLORER_API.md). These commands make every one of them scriptable offline:
//!
//! | command | engine |
//! |---|---|
//! | `sky` | `skyfix_almanac::sky::sky_state`, constellations from `skyfix_starfield` |
//! | `events` | `skyfix_almanac::events::day_events` |
//! | `phases`, `seasons` | `skyfix_almanac::events::{moon_phases, seasons}` |
//! | `eclipses`, `eclipse` | `skyfix_almanac::eclipses::Eclipses::{find, by_id, local, path}` |
//! | `planet-events` | `skyfix_almanac::planet_events::planet_events` |
//! | `noon`, `polaris`, `average` | `skyfix_core::methods::{noon, polaris, averaging}` |
//! | `running-fix` | `skyfix_motion::request::running_fix_session` |
//! | `predict` | `skyfix_core::sights::predict::predict_sextant` |
//! | `lunar` | `skyfix_core::sights::lunar::lunar_distance` |
//! | `plan-sights` | `skyfix_ephemeris::visibility::plan_sights` |
//!
//! Nothing here computes astronomy or navigation: each command parses flags, calls the
//! engine function the WASM export calls, and prints its result — `--format json` as
//! serde emits it (the wire shape), `--format text` in navigator style (degrees and
//! decimal arcminutes, UTC with `Z`). Exit codes are `crate::exit`'s.
//!
//! These subcommands are one [`ExplorerCommand`] enum, flattened into the top-level
//! command list by a single variant in `cli.rs`, so they arrive as one self-contained
//! module.

pub mod args;
pub mod average;
pub mod calendar;
pub mod deepsky;
pub mod eclipse;
pub mod eclipses;
pub mod events;
pub mod geomag;
pub mod limb;
pub mod lunar;
pub mod methods;
pub mod moon;
pub mod noon;
pub mod packs;
pub mod phases;
pub mod plan_sights;
pub mod planet_events;
pub mod planets;
pub mod polaris;
pub mod predict;
pub mod running_fix;
pub mod sailings;
pub mod sky;
pub mod sun;
pub mod text;
pub mod tides;
pub mod timescales;
pub mod wire;
pub mod zone;

use anyhow::Result;
use clap::Subcommand;

#[derive(Subcommand, Debug)]
pub enum ExplorerCommand {
    /// The whole sky from a place at an instant: altitude, azimuth, GHA, Dec, magnitude,
    /// phase and constellation of every body.
    Sky(sky::Args),

    /// One day's rise, set, transit and twilights, and the sky phases, in a chosen zone.
    Events(events::Args),

    /// New moon, first quarter, full moon and last quarter between two dates.
    Phases(phases::PhasesArgs),

    /// The equinoxes and solstices of a year.
    Seasons(phases::SeasonsArgs),

    /// Every solar and lunar eclipse in a window, and with --lat --lon whether each is
    /// seen from there.
    Eclipses(eclipses::Args),

    /// One eclipse: its contacts, what a place sees (--lat --lon), or its path (--path).
    Eclipse(eclipse::Args),

    /// Oppositions, conjunctions (and transits), greatest elongations and closest
    /// approaches of the planets in a window.
    PlanetEvents(planet_events::Args),

    /// Latitude, meridian passage and a (weak) longitude from a run of sights of one body
    /// around its meridian passage.
    Noon(noon::Args),

    /// Latitude from sights of Polaris, with the Nautical Almanac's a0, a1, a2 terms.
    Polaris(polaris::Args),

    /// Average a run of sights of one body into one sight, ready for a fix.
    Average(average::Args),

    /// A fix from sights taken under way, advanced along the dead-reckoning track to one
    /// instant.
    RunningFix(running_fix::Args),

    /// The predicted sextant reading and bearing of a body from a place at an instant.
    Predict(predict::Args),

    /// Clear a lunar distance and find the UTC it was taken at.
    Lunar(lunar::Args),

    /// Tonight's sights: the next evening and morning nautical twilight and the bodies
    /// to shoot in each, with their predicted readings.
    PlanSights(plan_sights::Args),

    /// A date in both calendars, with its Julian date, weekday, time scale (UTC or UT)
    /// and Delta-T.
    Calendar(calendar::Args),

    // ---- the expansion programme's engines (cli3 agent; docs/CLI.md) ----
    /// Golden and blue hour on one local day, with the Sun's rise, set and twilights.
    SunHours(sun::HoursArgs),

    /// The instants a body stands on a bearing, inside an altitude band.
    FindAzimuth(sun::FindAzimuthArgs),

    /// The days of a year a body rises, sets or stands at an altitude along a bearing.
    AlignmentDays(sun::AlignmentArgs),

    /// A body's rise and set bearings and its transit, every day of a year.
    RiseSetAzimuths(sun::RiseSetArgs),

    /// The Sun at one clock time every day of a year: the analemma.
    Analemma(sun::AnalemmaArgs),

    /// The Sun's path across one day, and the year's envelope of equinox and solstice
    /// paths.
    SunPath(sun::SunPathArgs),

    /// The equation of time and the Sun's declination on every date of a year.
    EquationOfTime(sun::EotArgs),

    /// A clear-sky estimate of the sunlight on a panel through one day.
    SolarDay(sun::SolarDayArgs),

    /// A clear-sky estimate of a panel's energy by month through a year, and the best tilt.
    SolarYear(sun::SolarYearArgs),

    /// When the galactic centre is up in a dark sky: the Milky Way planner's windows.
    GalacticCentre(sun::GalacticArgs),

    /// Magnetic variation and the Earth's field at a place and instant (WMM2025,
    /// IGRF-14).
    Variation(geomag::VariationArgs),

    /// Magnetic variation on a latitude-longitude grid, for isogonic lines.
    MagneticGrid(geomag::GridArgs),

    /// Compass error by a body's azimuth or amplitude, split into variation and
    /// deviation.
    CompassError(geomag::CompassArgs),

    /// Great-circle, rhumb-line, mid-latitude and composite sailing between two points,
    /// with waypoints and ETAs.
    Sailing(sailings::SailingArgs),

    /// Dead reckoning: where a course, speed and time run from a position.
    DrAdvance(sailings::DrArgs),

    /// Positions along a route of legs at given instants (the running fix's DR track).
    RoutePositions(sailings::RouteArgs),

    /// Which body was shot, from its altitude and bearing.
    StarId(sailings::StarIdArgs),

    /// A rotating star finder (2102-D) for a latitude: the stars on the base and the
    /// template.
    StarFinder(sailings::StarFinderArgs),

    /// An instant's time scale, coverage tier, Delta-T and DUT1 with their uncertainties,
    /// and its date in both calendars: the site's `time_info`.
    TimeInfo(timescales::TimeInfoArgs),

    /// A date or Julian date in the Julian and Gregorian calendars: the site's
    /// `calendar_convert`.
    CalendarConvert(timescales::CalendarConvertArgs),

    /// The data packs this build can install (--pack FILE loads one for a run).
    Packs(packs::PacksArgs),

    /// How the Moon is turned and lit: libration, position angles, the terminator, its
    /// distance and apparent size.
    MoonOrientation(moon::OrientationArgs),

    /// The Moon's 150 named features at an instant: which are lit, which are on the
    /// terminator tonight.
    MoonFeatures(moon::FeaturesArgs),

    /// Perigees and apogees, and new and full Moons with supermoons and micromoons.
    MoonApsides(moon::ApsidesArgs),

    /// Lunar occultations of bright stars and planets seen from a place.
    Occultations(moon::OccultationsArgs),

    /// The 213 deep-sky objects: Messier's 110 and 103 others by a stated rule.
    DsoCatalog(deepsky::CatalogArgs),

    /// Every deep-sky object's place at an instant, filtered by kind, brightness or
    /// altitude.
    DsoList(deepsky::ListArgs),

    /// One deep-sky object through a night: when it is best placed, and what shows it.
    Dso(deepsky::DsoArgs),

    /// The year's meteor showers, and with an observer the expected rates.
    Showers(deepsky::ShowersArgs),

    /// The Milky Way's outline: isophote rings for drawing.
    MilkyWay(deepsky::MilkyWayArgs),

    /// Find a star, deep-sky object, constellation, planet or meteor shower by name.
    Search(deepsky::SearchArgs),

    /// What a night offers: darkness, the Moon, planets, the best deep-sky objects,
    /// meteor showers and the Milky Way's core.
    Tonight(deepsky::TonightArgs),

    /// Atmospheric extinction and the limiting magnitude by altitude.
    Extinction(deepsky::ExtinctionArgs),

    /// Jupiter's four Galilean moons at an instant, as the Earth sees them.
    GalileanMoons(planets::MoonsArgs),

    /// Transits, shadow transits, occultations and eclipses of Jupiter's moons in a
    /// window.
    GalileanEvents(planets::MoonEventsArgs),

    /// Saturn's rings at an instant: their tilt, size and which face we see.
    SaturnRings(planets::RingsArgs),

    /// A planet's disc: its size, phase, pole and central meridians.
    PlanetDisc(planets::DiscArgs),

    /// Transits of Mercury and Venus in a window, and with --lat --lon what a place sees.
    Transits(planets::TransitsArgs),

    /// Close approaches of planets to each other, the Moon and bright stars.
    Conjunctions(planets::ConjunctionsArgs),

    /// When the planets stand still and turn retrograde, and turn back.
    Stations(planets::StationsArgs),

    /// The Earth's perihelion and aphelion in a year.
    EarthApsides(planets::EarthApsidesArgs),

    /// Comets and asteroids from orbital elements: the elements read, where the bodies
    /// are, or their tracks.
    Orbit(planets::OrbitArgs),

    /// The tide stations nearest a place (the tides-us pack: --pack).
    TideStations(tides::StationsNearArgs),

    /// One tide station: where it is, its kind, datums and notes.
    TideStation(tides::StationArgs),

    /// Tide heights at a station every few minutes: the tide curve.
    TidePredict(tides::PredictArgs),

    /// High and low water at a station in a window: a tide table.
    TideExtremes(tides::ExtremesArgs),

    /// The tide at a station at an instant, rising or falling, with the waters around it.
    TideNow(tides::NowArgs),

    /// What the loaded tides-us pack holds.
    TidePack(tides::PackArgs),

    /// The Moon's limb profile as a place sees it at an instant (the lunar-limb pack).
    LimbProfile(limb::ProfileArgs),

    /// What the loaded lunar-limb pack holds.
    LimbPack(limb::PackArgs),
}

/// Run one explorer command, returning the exit code it earned.
pub fn run(command: ExplorerCommand) -> Result<u8> {
    match command {
        ExplorerCommand::Sky(a) => sky::run(&a),
        ExplorerCommand::Events(a) => events::run(&a),
        ExplorerCommand::Phases(a) => phases::run_phases(&a),
        ExplorerCommand::Seasons(a) => phases::run_seasons(&a),
        ExplorerCommand::Eclipses(a) => eclipses::run(&a),
        ExplorerCommand::Eclipse(a) => eclipse::run(&a),
        ExplorerCommand::PlanetEvents(a) => planet_events::run(&a),
        ExplorerCommand::Noon(a) => noon::run(&a),
        ExplorerCommand::Polaris(a) => polaris::run(&a),
        ExplorerCommand::Average(a) => average::run(&a),
        ExplorerCommand::RunningFix(a) => running_fix::run(&a),
        ExplorerCommand::Predict(a) => predict::run(&a),
        ExplorerCommand::Lunar(a) => lunar::run(&a),
        ExplorerCommand::PlanSights(a) => plan_sights::run(&a),
        ExplorerCommand::Calendar(a) => calendar::run(&a),
        ExplorerCommand::SunHours(a) => sun::run_hours(&a),
        ExplorerCommand::FindAzimuth(a) => sun::run_find_azimuth(&a),
        ExplorerCommand::AlignmentDays(a) => sun::run_alignment(&a),
        ExplorerCommand::RiseSetAzimuths(a) => sun::run_rise_set(&a),
        ExplorerCommand::Analemma(a) => sun::run_analemma(&a),
        ExplorerCommand::SunPath(a) => sun::run_sun_path(&a),
        ExplorerCommand::EquationOfTime(a) => sun::run_eot(&a),
        ExplorerCommand::SolarDay(a) => sun::run_solar_day(&a),
        ExplorerCommand::SolarYear(a) => sun::run_solar_year(&a),
        ExplorerCommand::GalacticCentre(a) => sun::run_galactic(&a),
        ExplorerCommand::Variation(a) => geomag::run_variation(&a),
        ExplorerCommand::MagneticGrid(a) => geomag::run_grid(&a),
        ExplorerCommand::CompassError(a) => geomag::run_compass(&a),
        ExplorerCommand::Sailing(a) => sailings::run_sailing(&a),
        ExplorerCommand::DrAdvance(a) => sailings::run_dr(&a),
        ExplorerCommand::RoutePositions(a) => sailings::run_route(&a),
        ExplorerCommand::StarId(a) => sailings::run_star_id(&a),
        ExplorerCommand::StarFinder(a) => sailings::run_star_finder(&a),
        ExplorerCommand::TimeInfo(a) => timescales::run_time_info(&a),
        ExplorerCommand::CalendarConvert(a) => timescales::run_calendar_convert(&a),
        ExplorerCommand::Packs(a) => packs::run(&a),
        ExplorerCommand::MoonOrientation(a) => moon::run_orientation(&a),
        ExplorerCommand::MoonFeatures(a) => moon::run_features(&a),
        ExplorerCommand::MoonApsides(a) => moon::run_apsides(&a),
        ExplorerCommand::Occultations(a) => moon::run_occultations(&a),
        ExplorerCommand::DsoCatalog(a) => deepsky::run_catalog(&a),
        ExplorerCommand::DsoList(a) => deepsky::run_list(&a),
        ExplorerCommand::Dso(a) => deepsky::run_dso(&a),
        ExplorerCommand::Showers(a) => deepsky::run_showers(&a),
        ExplorerCommand::MilkyWay(a) => deepsky::run_milky_way(&a),
        ExplorerCommand::Search(a) => deepsky::run_search(&a),
        ExplorerCommand::Tonight(a) => deepsky::run_tonight(&a),
        ExplorerCommand::Extinction(a) => deepsky::run_extinction(&a),
        ExplorerCommand::GalileanMoons(a) => planets::run_moons(&a),
        ExplorerCommand::GalileanEvents(a) => planets::run_moon_events(&a),
        ExplorerCommand::SaturnRings(a) => planets::run_rings(&a),
        ExplorerCommand::PlanetDisc(a) => planets::run_disc(&a),
        ExplorerCommand::Transits(a) => planets::run_transits(&a),
        ExplorerCommand::Conjunctions(a) => planets::run_conjunctions(&a),
        ExplorerCommand::Stations(a) => planets::run_stations(&a),
        ExplorerCommand::EarthApsides(a) => planets::run_earth_apsides(&a),
        ExplorerCommand::Orbit(a) => planets::run_orbit(&a),
        ExplorerCommand::TideStations(a) => tides::run_stations_near(&a),
        ExplorerCommand::TideStation(a) => tides::run_station(&a),
        ExplorerCommand::TidePredict(a) => tides::run_predict(&a),
        ExplorerCommand::TideExtremes(a) => tides::run_extremes(&a),
        ExplorerCommand::TideNow(a) => tides::run_now(&a),
        ExplorerCommand::TidePack(a) => tides::run_pack(&a),
        ExplorerCommand::LimbProfile(a) => limb::run_profile(&a),
        ExplorerCommand::LimbPack(a) => limb::run_pack(&a),
    }
}
