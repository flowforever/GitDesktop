// Offline verification with the same minisign-verification crate and signed
// version field as tauri-plugin-updater. No network, native GUI or installs.
use base64::{Engine, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use std::{error::Error, fs, path::Path};

fn decode(encoded: &str) -> Result<String, Box<dyn Error>> {
    Ok(String::from_utf8(STANDARD.decode(encoded.trim())?)?)
}

fn verify_update(
    payload: &[u8],
    signature: &str,
    public_key: &str,
    installed_version: &Version,
    feed_version: &Version,
) -> Result<(), Box<dyn Error>> {
    if feed_version <= installed_version {
        return Err("update is not newer than the installed version".into());
    }
    let key = PublicKey::decode(&decode(public_key)?)?;
    let signature = Signature::decode(&decode(signature)?)?;
    key.verify(payload, &signature, true)?;

    // Only consult the trusted comment after verifying the signature.
    let signed = signature
        .trusted_comment()
        .split('\t')
        .find_map(|part| part.strip_prefix("version:"))
        .ok_or("missing signed version")?;
    if Version::parse(signed)? != *feed_version {
        return Err("signed version differs from the announced version".into());
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let dir = std::env::var("GITDESKTOP_SIGNATURE_FIXTURE_DIR")?;
    let dir = Path::new(&dir);
    let installed = Version::parse("1.99.99")?;
    let next = Version::parse("2.0.1")?;
    let claimed = Version::parse("2.0.2")?;
    let older = Version::parse("1.99.98")?;
    let payload = fs::read(dir.join("new.bin"))?;
    let older_payload = fs::read(dir.join("old.bin"))?;
    let signature = fs::read_to_string(dir.join("new.bin.sig"))?;
    let older_sig = fs::read_to_string(dir.join("old.bin.sig"))?;
    let legacy_sig = fs::read_to_string(dir.join("legacy.bin.sig"))?;
    let public_key = fs::read_to_string(dir.join("preview.key.pub"))?;
    let wrong_key = fs::read_to_string(dir.join("other.key.pub"))?;

    verify_update(&payload, &signature, &public_key, &installed, &next)?;

    // A newer published version is necessary but not sufficient.
    assert!(verify_update(&payload, &signature, &public_key, &next, &next).is_err());
    assert!(verify_update(&older_payload, &older_sig, &public_key, &installed, &older).is_err());
    assert!(verify_update(&payload, &signature, &public_key, &installed, &claimed).is_err());
    assert!(verify_update(&older_payload, &older_sig, &public_key, &installed, &next).is_err());
    assert!(verify_update(&payload, &signature, &wrong_key, &installed, &next).is_err());
    assert!(verify_update(b"tampered preview", &signature, &public_key, &installed, &next).is_err());
    assert!(verify_update(&payload, &legacy_sig, &public_key, &installed, &next).is_err());
    println!("Signed preview fixture passed: accepted newer authentic payload; rejected same/older versions, wrong key, tampering, and missing/mismatched signed version.");
    Ok(())
}
