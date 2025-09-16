;; contracts/MedicalRecordVault.clar

(define-constant ERR-NOT-OWNER u300)
(define-constant ERR-RECORD-EXISTS u301)
(define-constant ERR-INVALID-HASH u302)
(define-constant ERR-INVALID-CATEGORY u303)
(define-constant ERR-INVALID-SENSITIVITY u304)
(define-constant ERR-INVALID-TIMESTAMP u305)
(define-constant ERR-MAX-RECORDS-EXCEEDED u306)
(define-constant ERR-INVALID-UPDATE u307)
(define-constant ERR-NOT-AUTHORIZED u308)
(define-constant ERR-AUTHORITY-NOT-VERIFIED u309)
(define-constant ERR-INVALID-MAX-RECORDS u310)
(define-constant ERR-INVALID-FEE u311)

(define-data-var next-record-id uint u0)
(define-data-var max-records-per-user uint u100)
(define-data-var update-fee uint u500)
(define-data-var authority-contract (optional principal) none)

(define-map medical-records
  {user: principal, record-id: uint}
  {
    data-hash: (string-ascii 64),
    category: (string-utf8 20),
    sensitivity: uint,
    timestamp: uint,
    version: uint,
    encrypted: bool,
    metadata: (string-utf8 200)
  }
)

(define-map user-record-counts principal uint)

(define-map record-updates
  {user: principal, record-id: uint}
  {
    update-hash: (string-ascii 64),
    update-category: (string-utf8 20),
    update-sensitivity: uint,
    update-timestamp: uint,
    updater: principal
  }
)

(define-read-only (get-record (user principal) (record-id uint))
  (map-get? medical-records {user: user, record-id: record-id})
)

(define-read-only (get-record-updates (user principal) (record-id uint))
  (map-get? record-updates {user: user, record-id: record-id})
)

(define-read-only (get-user-record-count (user principal))
  (map-get? user-record-counts user)
)

(define-read-only (is-record-encrypted (user principal) (record-id uint))
  (match (map-get? medical-records {user: user, record-id: record-id})
    record (get encrypted record)
    false
  )
)

(define-private (validate-hash (h (string-ascii 64)))
  (if (and (> (len h) u0) (<= (len h) u64)) (ok true) (err ERR-INVALID-HASH))
)

(define-private (validate-category (cat (string-utf8 20)))
  (if (or (is-eq cat "vital") (is-eq cat "lab") (is-eq cat "imaging") (is-eq cat "prescription") (is-eq cat "other"))
      (ok true)
      (err ERR-INVALID-CATEGORY))
)

(define-private (validate-sensitivity (sens uint))
  (if (<= sens u3) (ok true) (err ERR-INVALID-SENSITIVITY))
)

(define-private (validate-timestamp (ts uint))
  (if (>= ts block-height) (ok true) (err ERR-INVALID-TIMESTAMP))
)

(define-private (validate-metadata (meta (string-utf8 200)))
  (if (<= (len meta) u200) (ok true) (err ERR-INVALID-UPDATE))
)

(define-private (validate-principal (p principal))
  (if (not (is-eq p 'SP000000000000000000002Q6VF78)) (ok true) (err ERR-NOT-AUTHORIZED))
)

(define-public (set-authority-contract (contract-principal principal))
  (begin
    (try! (validate-principal contract-principal))
    (asserts! (is-none (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (var-set authority-contract (some contract-principal))
    (ok true)
  )
)

(define-public (set-max-records-per-user (new-max uint))
  (begin
    (asserts! (> new-max u0) (err ERR-INVALID-MAX-RECORDS))
    (asserts! (is-some (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (var-set max-records-per-user new-max)
    (ok true)
  )
)

(define-public (set-update-fee (new-fee uint))
  (begin
    (asserts! (>= new-fee u0) (err ERR-INVALID-FEE))
    (asserts! (is-some (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (var-set update-fee new-fee)
    (ok true)
  )
)

(define-public (store-record (record-id uint) (data-hash (string-ascii 64)) (category (string-utf8 20)) (sensitivity uint) (metadata (string-utf8 200)))
  (let ((caller tx-sender)
        (count (default-to u0 (get-user-record-count caller))))
    (asserts! (< count (var-get max-records-per-user)) (err ERR-MAX-RECORDS-EXCEEDED))
    (try! (validate-hash data-hash))
    (try! (validate-category category))
    (try! (validate-sensitivity sensitivity))
    (try! (validate-metadata metadata))
    (let ((key {user: caller, record-id: record-id})
          (next-id (var-get next-record-id)))
      (asserts! (is-none (map-get? medical-records key)) (err ERR-RECORD-EXISTS))
      (map-set medical-records key
        {
          data-hash: data-hash,
          category: category,
          sensitivity: sensitivity,
          timestamp: block-height,
          version: u1,
          encrypted: true,
          metadata: metadata
        }
      )
      (map-set user-record-counts caller (+ count u1))
      (var-set next-record-id (+ next-id u1))
      (print {event: "record-stored", user: caller, record-id: record-id, hash: data-hash})
      (ok {record-key: key, global-id: next-id})
    )
  )
)

(define-public (update-record (record-id uint) (new-hash (string-ascii 64)) (new-category (string-utf8 20)) (new-sensitivity uint) (new-metadata (string-utf8 200)))
  (let ((caller tx-sender)
        (key {user: caller, record-id: record-id})
        (existing (unwrap! (map-get? medical-records key) (err ERR-NOT-OWNER))))
    (try! (validate-hash new-hash))
    (try! (validate-category new-category))
    (try! (validate-sensitivity new-sensitivity))
    (try! (validate-metadata new-metadata))
    (let ((authority (unwrap! (var-get authority-contract) (err ERR-AUTHORITY-NOT-VERIFIED))))
      (try! (stx-transfer? (var-get update-fee) tx-sender authority))
    )
    (map-set medical-records key
      {
        data-hash: new-hash,
        category: new-category,
        sensitivity: new-sensitivity,
        timestamp: block-height,
        version: (+ (get version existing) u1),
        encrypted: true,
        metadata: new-metadata
      }
    )
    (map-set record-updates key
      {
        update-hash: new-hash,
        update-category: new-category,
        update-sensitivity: new-sensitivity,
        update-timestamp: block-height,
        updater: caller
      }
    )
    (print {event: "record-updated", user: caller, record-id: record-id, new-hash: new-hash})
    (ok {updated-key: key})
  )
)

(define-public (get-total-records)
  (ok (var-get next-record-id))
)

(define-public (check-record-existence (user principal) (record-id uint))
  (ok (is-some (map-get? medical-records {user: user, record-id: record-id})))
)