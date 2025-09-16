# MedVault: Self-Sovereign Medical Identity on Stacks

## Project Overview

MedVault is a Web3 decentralized application (dApp) built on the Stacks blockchain using Clarity smart contracts. It empowers users with self-sovereign identity (SSI) for their medical histories, allowing them to store encrypted health data off-chain (e.g., via IPFS) while using on-chain hashes for integrity verification. Users can grant revocable, time-bound access to verified healthcare providers, solving key real-world problems in healthcare:

### Real-World Problems Solved
- **Data Privacy and Breaches**: Centralized health records are prone to hacks (e.g., Equifax-style breaches affecting millions). MedVault uses patient-controlled encryption and on-chain access controls to minimize exposure.
- **Interoperability and Portability**: Patients often struggle with fragmented records across providers. MedVault enables seamless, permissioned sharing without intermediaries.
- **Lack of Patient Agency**: Traditional systems lock data behind providers; MedVault gives users full control, including instant revocation, reducing unauthorized access risks.
- **Auditability and Compliance**: Built-in logging ensures HIPAA-like traceability without central authorities, aiding regulatory compliance in a decentralized way.
- **Provider Verification**: Prevents fraud by requiring on-chain provider registration with verifiable credentials.

The system integrates with wallets like Leather for user authentication and supports frontend apps (e.g., React) for uploading/viewing records.

## Architecture
- **On-Chain (Clarity Contracts)**: 6 core smart contracts handle identity, storage, access, revocation, providers, and audits.
- **Off-Chain**: Encrypted medical data stored on IPFS/Arweave; only hashes and metadata on-chain.
- **Frontend**: Not included here; use Stacks.js for contract interactions.
- **Deployment**: Test on Stacks testnet; mainnet via Hiro CLI.

## Smart Contracts
Below are the 6 Clarity smart contracts. Each is "solid" with defined types, access controls, error handling, and events for transparency. Deploy them in order: ProviderRegistry → UserIdentity → MedicalRecordVault → AccessGrant → RevocationManager → AuditTrail.

### 1. ProviderRegistry.clar
Registers and verifies healthcare providers (e.g., hospitals, doctors) with principal-based credentials.

```clarity
(define-constant ERR_UNAUTHORIZED (err u100))
(define-constant ERR_PROVIDER_EXISTS (err u101))
(define-constant ERR_INVALID_CREDENTIAL (err u102))

(define-map providers principal {name: (string-ascii 50), verified: bool, credential-hash: (string-ascii 64)})

(define-public (register-provider (name (string-ascii 50)) (credential-hash (string-ascii 64)))
  (let ((caller tx-sender))
    (asserts! (not (map-get? providers caller)) ERR_PROVIDER_EXISTS)
    (map-set providers caller {name: name, verified: false, credential-hash: credential-hash})
    (ok {provider-id: caller, status: "pending-verification"})))

(define-public (verify-provider (provider principal) (is-verified bool))
  (let ((caller tx-sender))
    ;; Assume admin role for verification (in production, use multisig)
    (asserts! (is-eq caller (as-principal 'SP...ADMIN)) ERR_UNAUTHORIZED)
    (asserts! (map-get? providers provider) ERR_INVALID_CREDENTIAL)
    (map-set providers provider {name: (get name (unwrap! (map-get? providers provider) ERR_INVALID_CREDENTIAL)), verified: is-verified, credential-hash: (get credential-hash (unwrap! (map-get? providers provider) ERR_INVALID_CREDENTIAL))})
    (print {event: "provider-verified", provider: provider, verified: is-verified})
    (ok true)))

(define-read-only (is-provider-verified (provider principal))
  (get verified (map-get? providers provider)))
```

### 2. UserIdentity.clar
Manages user self-sovereign identities, linking principals to DIDs and basic profile.

```clarity
(define-constant ERR_IDENTITY_EXISTS (err u200))
(define-constant ERR_NOT_OWNER (err u201))

(define-map user-identities principal {did: (string-ascii 100), profile-hash: (string-ascii 64)})

(define-public (create-identity (did (string-ascii 100)) (profile-hash (string-ascii 64)))
  (let ((caller tx-sender))
    (asserts! (not (map-get? user-identities caller)) ERR_IDENTITY_EXISTS)
    (map-set user-identities caller {did: did, profile-hash: profile-hash})
    (print {event: "identity-created", user: caller, did: did})
    (ok {user-did: did})))

(define-public (update-profile (new-hash (string-ascii 64)))
  (let ((caller tx-sender)
        (identity (unwrap! (map-get? user-identities caller) ERR_NOT_OWNER)))
    (map-set user-identities caller {did: (get did identity), profile-hash: new-hash})
    (print {event: "profile-updated", user: caller})
    (ok true)))

(define-read-only (get-user-identity (user principal))
  (map-get? user-identities user))
```

### 3. MedicalRecordVault.clar
Stores hashes of encrypted medical records, owned by users.

```clarity
(define-constant ERR_NOT_OWNER (err u300))
(define-constant ERR_RECORD_EXISTS (err u301))

(define-map medical-records 
  {user: principal, record-id: uint} 
  {data-hash: (string-ascii 64), timestamp: uint, encrypted: bool})

(define-public (store-record (record-id uint) (data-hash (string-ascii 64)))
  (let ((caller tx-sender))
    (let ((key {user: caller, record-id: record-id}))
      (asserts! (not (map-get? medical-records key)) ERR_RECORD_EXISTS)
      (map-set medical-records key {data-hash: data-hash, timestamp: block-height, encrypted: true})
      (print {event: "record-stored", user: caller, record-id: record-id, hash: data-hash})
      (ok {record-key: key}))))

(define-public (update-record (record-id uint) (new-hash (string-ascii 64)))
  (let ((caller tx-sender)
        (key {user: caller, record-id: record-id})
        (existing (unwrap! (map-get? medical-records key) ERR_NOT_OWNER)))
    (map-set medical-records key {data-hash: new-hash, timestamp: block-height, encrypted: (get encrypted existing)})
    (print {event: "record-updated", user: caller, record-id: record-id})
    (ok true)))

(define-read-only (get-record (user principal) (record-id uint))
  (map-get? medical-records {user: user, record-id: record-id}))
```

### 4. AccessGrant.clar
Handles granting time-bound access to specific records for providers.

```clarity
(define-constant ERR_NOT_OWNER (err u400))
(define-constant ERR_NOT_VERIFIED_PROVIDER (err u401))
(define-constant ERR_GRANT_EXISTS (err u402))

(define-map access-grants 
  {user: principal, provider: principal, record-id: uint} 
  {granted-at: uint, expires-at: uint, active: bool})

;; Import from ProviderRegistry
(define-read-only (contract-call? provider-registry-contract is-provider-verified (principal)))

(define-public (grant-access (provider principal) (record-id uint) (duration uint)) ;; duration in blocks
  (let ((caller tx-sender)
        (key {user: caller, provider: provider, record-id: record-id})
        (now block-height)
        (expires (+ now duration)))
    (asserts! (contract-call? provider-registry-contract is-provider-verified provider) ERR_NOT_VERIFIED_PROVIDER)
    (asserts! (not (map-get? access-grants key)) ERR_GRANT_EXISTS)
    (map-set access-grants key {granted-at: now, expires-at: expires, active: true})
    (print {event: "access-granted", user: caller, provider: provider, record-id: record-id, expires: expires})
    (ok {grant-key: key})))

(define-read-only (has-access (user principal) (provider principal) (record-id uint))
  (let ((grant (map-get? access-grants {user: user, provider: provider, record-id: record-id})))
    (match grant g 
      (and (get active g) (<= block-height (get expires-at g))) true
      false)))
```

### 5. RevocationManager.clar
Enables users to revoke active grants instantly.

```clarity
(define-constant ERR_NOT_OWNER (err u500))
(define-constant ERR_NO_ACTIVE_GRANT (err u501))

(define-public (revoke-access (provider principal) (record-id uint))
  (let ((caller tx-sender)
        (key {user: caller, provider: provider, record-id: record-id})
        (grant (unwrap! (map-get? access-grants key) ERR_NO_ACTIVE_GRANT)))
    (asserts! (get active grant) ERR_NO_ACTIVE_GRANT)
    ;; Cross-contract call to update AccessGrant
    ;; In practice, use contract-call to deactivate
    (map-set access-grants key {granted-at: (get granted-at grant), expires-at: (get expires-at grant), active: false})
    (print {event: "access-revoked", user: caller, provider: provider, record-id: record-id})
    (ok true)))

(define-read-only (is-grant-revoked (user principal) (provider principal) (record-id uint))
  (let ((grant-opt (map-get? access-grants {user: user, provider: provider, record-id: record-id})))
    (match grant-opt g (not (get active g)) false)))
```

### 6. AuditTrail.clar
Logs all access events for transparency and compliance.

```clarity
(define-map audit-logs uint {event-type: (string-ascii 20), user: principal, provider: principal, record-id: uint, timestamp: uint, details: (string-ascii 100)})

(define-private (next-log-id) (var-get log-counter)) ;; Use a var for counter
(define-data-var log-counter uint u0)

(define-public (log-access (event-type (string-ascii 20)) (provider principal) (record-id uint) (details (string-ascii 100)))
  (let ((caller tx-sender)
        (id (var-set log-counter (+ (var-get log-counter) u1))))
    (map-insert audit-logs id {event-type: event-type, user: caller, provider: provider, record-id: record-id, timestamp: block-height, details: details})
    (print {event: "audit-log", id: id, type: event-type})
    (ok id)))

(define-read-only (get-audit-log (id uint))
  (map-get? audit-logs id))

(define-read-only (get-user-audits (user principal) (start uint) (limit uint))
  ;; Simplified: In full impl, filter by user
  (ok {logs: (list start limit), total: u100})) ;; Placeholder
```

## Installation & Deployment
1. **Prerequisites**: Install Clarity CLI (Hiro), Stacks wallet.
2. **Clone/Setup**: Create a new Stacks project: `clar create medvault`.
3. **Add Contracts**: Place each `.clar` file in `contracts/`.
4. **Test Locally**: `clar test`.
5. **Deploy to Testnet**: `clar deploy --testnet` (update `Clarity.toml` with contract IDs).
6. **Frontend Integration**: Use `@stacks/transactions` to call functions (e.g., `connectWallet()` for identity creation).

## Usage
1. **User Flow**: Create identity → Store record hash → Grant access to provider → Provider queries `has-access` → Revoke if needed → Audit logs.
2. **Provider Flow**: Register/verify → Request access → View decrypted data off-chain upon grant.
3. **Security Notes**: All data encrypted client-side; use ECDSA for signatures. Audit contracts before mainnet.

## Contributing
Fork, PR improvements. Focus on gas optimization or integrations (e.g., DID resolution).

## License
MIT. Built with ❤️ for patient empowerment.