//! verify2 scratch (not committed): Rigil Kentaurus's barycentric direction from the
//! engine's own catalogue entry, on its orbit and on the catalogue's straight line.
use skyfix_ephemeris::catalog;
fn main() {
    let s = catalog::find("Rigil Kentaurus").expect("star");
    let mut line = s.clone();
    line.orbit = None;
    line.bary_pm_ra_cosdec_mas_per_year = s.pm_ra_cosdec_mas_per_year;
    line.bary_pm_dec_mas_per_year = s.pm_dec_mas_per_year;
    println!(
        "# bary_pm {} {}",
        s.bary_pm_ra_cosdec_mas_per_year, s.bary_pm_dec_mas_per_year
    );
    for a in std::env::args().skip(1) {
        let jd: f64 = a.parse().unwrap();
        let o = s.barycentric_direction(jd);
        let l = line.barycentric_direction(jd);
        println!(
            "{jd} {:.15} {:.15} {:.15} {:.15} {:.15} {:.15}",
            o[0], o[1], o[2], l[0], l[1], l[2]
        );
    }
}
