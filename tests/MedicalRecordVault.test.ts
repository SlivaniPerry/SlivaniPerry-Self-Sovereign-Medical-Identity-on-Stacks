import { describe, it, expect, beforeEach } from "vitest";
import { stringAsciiCV, stringUtf8CV, uintCV } from "@stacks/transactions";

const ERR_NOT_OWNER = 300;
const ERR_RECORD_EXISTS = 301;
const ERR_INVALID_HASH = 302;
const ERR_INVALID_CATEGORY = 303;
const ERR_INVALID_SENSITIVITY = 304;
const ERR_MAX_RECORDS_EXCEEDED = 306;
const ERR_INVALID_UPDATE = 307;
const ERR_AUTHORITY_NOT_VERIFIED = 309;

interface MedicalRecord {
  dataHash: string;
  category: string;
  sensitivity: number;
  timestamp: number;
  version: number;
  encrypted: boolean;
  metadata: string;
}

interface RecordUpdate {
  updateHash: string;
  updateCategory: string;
  updateSensitivity: number;
  updateTimestamp: number;
  updater: string;
}

interface Result<T> {
  ok: boolean;
  value: T | { errorCode: number };
}

class MedicalRecordVaultMock {
  state: {
    nextRecordId: number;
    maxRecordsPerUser: number;
    updateFee: number;
    authorityContract: string | null;
    medicalRecords: Map<string, MedicalRecord>;
    userRecordCounts: Map<string, number>;
    recordUpdates: Map<string, RecordUpdate>;
  } = {
    nextRecordId: 0,
    maxRecordsPerUser: 100,
    updateFee: 500,
    authorityContract: null,
    medicalRecords: new Map(),
    userRecordCounts: new Map(),
    recordUpdates: new Map(),
  };
  blockHeight: number = 0;
  caller: string = "ST1TEST";
  authorities: Set<string> = new Set(["ST1TEST"]);
  stxTransfers: Array<{ amount: number; from: string; to: string | null }> = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      nextRecordId: 0,
      maxRecordsPerUser: 100,
      updateFee: 500,
      authorityContract: null,
      medicalRecords: new Map(),
      userRecordCounts: new Map(),
      recordUpdates: new Map(),
    };
    this.blockHeight = 0;
    this.caller = "ST1TEST";
    this.authorities = new Set(["ST1TEST"]);
    this.stxTransfers = [];
  }

  isVerifiedAuthority(principal: string): Result<boolean> {
    return { ok: true, value: this.authorities.has(principal) };
  }

  setAuthorityContract(contractPrincipal: string): Result<boolean> {
    if (contractPrincipal === "SP000000000000000000002Q6VF78") {
      return { ok: false, value: false };
    }
    if (this.state.authorityContract !== null) {
      return { ok: false, value: false };
    }
    this.state.authorityContract = contractPrincipal;
    return { ok: true, value: true };
  }

  setMaxRecordsPerUser(newMax: number): Result<boolean> {
    if (!this.state.authorityContract) return { ok: false, value: false };
    if (newMax <= 0) return { ok: false, value: false };
    this.state.maxRecordsPerUser = newMax;
    return { ok: true, value: true };
  }

  setUpdateFee(newFee: number): Result<boolean> {
    if (!this.state.authorityContract) return { ok: false, value: false };
    if (newFee < 0) return { ok: false, value: false };
    this.state.updateFee = newFee;
    return { ok: true, value: true };
  }

  storeRecord(
    recordId: number,
    dataHash: string,
    category: string,
    sensitivity: number,
    metadata: string
  ): Result<{ recordKey: { user: string; recordId: number }; globalId: number }> {
    const count = this.state.userRecordCounts.get(this.caller) || 0;
    if (count >= this.state.maxRecordsPerUser) {
      return { ok: false, value: { errorCode: ERR_MAX_RECORDS_EXCEEDED } };
    }
    if (!dataHash || dataHash.length > 64) {
      return { ok: false, value: { errorCode: ERR_INVALID_HASH } };
    }
    if (!["vital", "lab", "imaging", "prescription", "other"].includes(category)) {
      return { ok: false, value: { errorCode: ERR_INVALID_CATEGORY } };
    }
    if (sensitivity > 3) {
      return { ok: false, value: { errorCode: ERR_INVALID_SENSITIVITY } };
    }
    if (metadata.length > 200) {
      return { ok: false, value: { errorCode: ERR_INVALID_UPDATE } };
    }
    const key = `${this.caller}-${recordId}`;
    if (this.state.medicalRecords.has(key)) {
      return { ok: false, value: { errorCode: ERR_RECORD_EXISTS } };
    }
    if (!this.state.authorityContract) {
      return { ok: false, value: { errorCode: ERR_AUTHORITY_NOT_VERIFIED } };
    }

    const record: MedicalRecord = {
      dataHash,
      category,
      sensitivity,
      timestamp: this.blockHeight,
      version: 1,
      encrypted: true,
      metadata,
    };
    this.state.medicalRecords.set(key, record);
    this.state.userRecordCounts.set(this.caller, count + 1);
    const globalId = this.state.nextRecordId;
    this.state.nextRecordId++;
    return { ok: true, value: { recordKey: { user: this.caller, recordId }, globalId } };
  }

  getRecord(user: string, recordId: number): MedicalRecord | null {
    const key = `${user}-${recordId}`;
    return this.state.medicalRecords.get(key) || null;
  }

  updateRecord(
    recordId: number,
    newHash: string,
    newCategory: string,
    newSensitivity: number,
    newMetadata: string
  ): Result<{ updatedKey: { user: string; recordId: number } }> {
    const key = `${this.caller}-${recordId}`;
    const existing = this.state.medicalRecords.get(key);
    if (!existing) {
      return { ok: false, value: { errorCode: ERR_NOT_OWNER } };
    }
    if (!newHash || newHash.length > 64) {
      return { ok: false, value: { errorCode: ERR_INVALID_HASH } };
    }
    if (!["vital", "lab", "imaging", "prescription", "other"].includes(newCategory)) {
      return { ok: false, value: { errorCode: ERR_INVALID_CATEGORY } };
    }
    if (newSensitivity > 3) {
      return { ok: false, value: { errorCode: ERR_INVALID_SENSITIVITY } };
    }
    if (newMetadata.length > 200) {
      return { ok: false, value: { errorCode: ERR_INVALID_UPDATE } };
    }
    if (!this.state.authorityContract) {
      return { ok: false, value: { errorCode: ERR_AUTHORITY_NOT_VERIFIED } };
    }

    this.stxTransfers.push({ amount: this.state.updateFee, from: this.caller, to: this.state.authorityContract });

    const updated: MedicalRecord = {
      dataHash: newHash,
      category: newCategory,
      sensitivity: newSensitivity,
      timestamp: this.blockHeight,
      version: existing.version + 1,
      encrypted: true,
      metadata: newMetadata,
    };
    this.state.medicalRecords.set(key, updated);
    this.state.recordUpdates.set(key, {
      updateHash: newHash,
      updateCategory: newCategory,
      updateSensitivity: newSensitivity,
      updateTimestamp: this.blockHeight,
      updater: this.caller,
    });
    return { ok: true, value: { updatedKey: { user: this.caller, recordId } } };
  }

  getTotalRecords(): Result<number> {
    return { ok: true, value: this.state.nextRecordId };
  }

  checkRecordExistence(user: string, recordId: number): Result<boolean> {
    const key = `${user}-${recordId}`;
    return { ok: true, value: this.state.medicalRecords.has(key) };
  }

  isRecordEncrypted(user: string, recordId: number): boolean {
    const key = `${user}-${recordId}`;
    const record = this.state.medicalRecords.get(key);
    return record ? record.encrypted : false;
  }
}

describe("MedicalRecordVault", () => {
  let contract: MedicalRecordVaultMock;

  beforeEach(() => {
    contract = new MedicalRecordVaultMock();
    contract.reset();
  });

  it("stores a record successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.storeRecord(1, "abc123def456...", "vital", 1, "Patient metadata");
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ recordKey: { user: "ST1TEST", recordId: 1 }, globalId: 0 });

    const record = contract.getRecord("ST1TEST", 1);
    expect(record?.dataHash).toBe("abc123def456...");
    expect(record?.category).toBe("vital");
    expect(record?.sensitivity).toBe(1);
    expect(record?.timestamp).toBe(0);
    expect(record?.version).toBe(1);
    expect(record?.encrypted).toBe(true);
    expect(record?.metadata).toBe("Patient metadata");
    expect(contract.state.userRecordCounts.get("ST1TEST")).toBe(1);
  });

  it("rejects duplicate record", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.storeRecord(1, "hash1", "lab", 2, "Meta1");
    const result = contract.storeRecord(1, "hash2", "imaging", 3, "Meta2");
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ errorCode: ERR_RECORD_EXISTS });
  });

  it("rejects store without authority", () => {
    const result = contract.storeRecord(1, "hash1", "vital", 1, "Meta1");
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ errorCode: ERR_AUTHORITY_NOT_VERIFIED });
  });

  it("rejects invalid hash", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.storeRecord(1, "", "vital", 1, "Meta1");
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ errorCode: ERR_INVALID_HASH });
  });

  it("rejects invalid category", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.storeRecord(1, "hash1", "invalid", 1, "Meta1");
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ errorCode: ERR_INVALID_CATEGORY });
  });

  it("rejects invalid sensitivity", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.storeRecord(1, "hash1", "vital", 4, "Meta1");
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ errorCode: ERR_INVALID_SENSITIVITY });
  });

  it("rejects max records exceeded", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.state.maxRecordsPerUser = 0;
    const result = contract.storeRecord(1, "hash1", "vital", 1, "Meta1");
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ errorCode: ERR_MAX_RECORDS_EXCEEDED });
  });

  it("updates a record successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.storeRecord(1, "oldhash", "vital", 1, "Old meta");
    const result = contract.updateRecord(1, "newhash", "lab", 2, "New meta");
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ updatedKey: { user: "ST1TEST", recordId: 1 } });

    const record = contract.getRecord("ST1TEST", 1);
    expect(record?.dataHash).toBe("newhash");
    expect(record?.category).toBe("lab");
    expect(record?.sensitivity).toBe(2);
    expect(record?.version).toBe(2);
    expect(contract.stxTransfers).toEqual([{ amount: 500, from: "ST1TEST", to: "ST2TEST" }]);
    const update = contract.state.recordUpdates.get("ST1TEST-1");
    expect(update?.updateHash).toBe("newhash");
    expect(update?.updater).toBe("ST1TEST");
  });

  it("rejects update for non-existent record", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.updateRecord(999, "newhash", "lab", 2, "New meta");
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ errorCode: ERR_NOT_OWNER });
  });

  it("rejects update without authority", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.storeRecord(1, "oldhash", "vital", 1, "Old meta");
    contract.state.authorityContract = null;
    const result = contract.updateRecord(1, "newhash", "lab", 2, "New meta");
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ errorCode: ERR_AUTHORITY_NOT_VERIFIED });
  });

  it("rejects update invalid category", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.storeRecord(1, "oldhash", "vital", 1, "Old meta");
    const result = contract.updateRecord(1, "newhash", "invalid", 2, "New meta");
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ errorCode: ERR_INVALID_CATEGORY });
  });

  it("sets max records per user successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.setMaxRecordsPerUser(50);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.maxRecordsPerUser).toBe(50);
  });

  it("rejects set max records without authority", () => {
    const result = contract.setMaxRecordsPerUser(50);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("sets update fee successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.setUpdateFee(1000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.updateFee).toBe(1000);
    contract.storeRecord(1, "hash1", "vital", 1, "Meta1");
    contract.updateRecord(1, "newhash", "lab", 2, "New meta");
    expect(contract.stxTransfers[0]?.amount).toBe(1000);
  });

  it("rejects set update fee without authority", () => {
    const result = contract.setUpdateFee(1000);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("returns total records correctly", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.storeRecord(1, "hash1", "vital", 1, "Meta1");
    contract.storeRecord(2, "hash2", "lab", 2, "Meta2");
    const result = contract.getTotalRecords();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(2);
  });

  it("checks record existence correctly", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.storeRecord(1, "hash1", "vital", 1, "Meta1");
    let result = contract.checkRecordExistence("ST1TEST", 1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    result = contract.checkRecordExistence("ST1TEST", 2);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(false);
  });

  it("checks encryption status correctly", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.storeRecord(1, "hash1", "vital", 1, "Meta1");
    expect(contract.isRecordEncrypted("ST1TEST", 1)).toBe(true);
    expect(contract.isRecordEncrypted("ST1TEST", 999)).toBe(false);
  });

  it("parses parameters with Clarity types", () => {
    const hashCV = stringAsciiCV("abc123def456...");
    const categoryCV = stringUtf8CV("vital");
    const sensitivityCV = uintCV(1);
    const metadataCV = stringUtf8CV("Patient metadata");
    expect(hashCV.value).toBe("abc123def456...");
    expect(categoryCV.value).toBe("vital");
    expect(sensitivityCV.value).toEqual(BigInt(1));
    expect(metadataCV.value).toBe("Patient metadata");
  });

  it("rejects update with invalid metadata length", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.storeRecord(1, "oldhash", "vital", 1, "Old meta");
    const longMeta = "a".repeat(201);
    const result = contract.updateRecord(1, "newhash", "lab", 2, longMeta);
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({ errorCode: ERR_INVALID_UPDATE });
  });

  it("sets authority contract successfully", () => {
    const result = contract.setAuthorityContract("ST2TEST");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.authorityContract).toBe("ST2TEST");
  });

  it("rejects invalid authority contract", () => {
    const result = contract.setAuthorityContract("SP000000000000000000002Q6VF78");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });
});