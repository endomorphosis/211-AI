import {
  AuditEvent,
  AnalyticsStudy,
  CheckInPolicyDraft,
  DisclosureDataScope,
  DisclosureRecipientDraft,
  ExportBundleView,
  ProofReceiptView,
  RegistrationProfileDraft,
  ServiceMatch,
  ShelterContactRequest,
  UploadItem,
  WalletAccessRequest,
  WalletGrantReceipt
} from "../models/abby";

export const defaultDisclosureScopes: DisclosureDataScope[] = [
  "identity_minimum",
  "profile",
  "photo",
  "current_location",
  "uploaded_documents",
  "missed_check_in",
  "found_permanent_housing",
  "medical_notes",
  "shelter_history",
  "benefits_information",
  "custom"
];

export const emptyRegistrationProfile: RegistrationProfileDraft = {
  legalName: "",
  preferredName: "",
  pronouns: "",
  dateOfBirth: "",
  photoAssetId: "",
  phone: "",
  email: "",
  currentLocation: "",
  shelterAffiliation: "",
  serviceNeeds: [],
  servicePartnerHelpRequested: false,
  servicePartnerHelpRequestedAt: "",
  preferredCheckInChannels: ["web"],
  easyBotCheckStatus: "pending",
  captchaToken: ""
};

export const defaultCheckInPolicy: CheckInPolicyDraft = {
  intervalDays: 7,
  reminderChannels: ["sms", "web"],
  gracePeriodHours: 24,
  escalationEnabled: true,
  lastCheckInAt: new Date().toISOString()
};

export const initialRecipients: DisclosureRecipientDraft[] = [
  {
    id: "rec-1",
    type: "emergency_contact",
    displayName: "Maya Johnson",
    relationship: "Sister",
    email: "maya@example.org",
    phone: "(503) 555-0129",
    agencyName: "",
    precinctName: "",
    verified: true,
    allowedScopes: [...defaultDisclosureScopes]
  },
  {
    id: "rec-2",
    type: "social_worker",
    displayName: "Case Worker Desk",
    relationship: "Assigned advocate",
    email: "intake@example.org",
    phone: "(503) 555-0144",
    agencyName: "Downtown Outreach",
    precinctName: "",
    verified: false,
    allowedScopes: [...defaultDisclosureScopes]
  }
];

export const initialShelterContactRequests: ShelterContactRequest[] = [
  {
    id: "shelter-request-1",
    direction: "shelter_to_user",
    status: "pending",
    shelterName: "Downtown Outreach Shelter",
    userName: "Abby Example",
    userContact: "abby@example.org",
    staffId: "staff-demo-downtown",
    staffName: "Jordan Lee",
    createdAt: "Today, 8:45 AM"
  },
  {
    id: "shelter-request-2",
    direction: "user_to_shelter",
    status: "pending",
    shelterName: "Rose City Shelter",
    userName: "Abby Example",
    userContact: "abby@example.org",
    createdAt: "Today, 9:05 AM"
  }
];

export const initialUploads: UploadItem[] = [
  {
    id: "up-1",
    fileName: "State ID file",
    machineSummary: "State Id File",
    category: "Identity",
    sensitivity: "high",
    status: "stored",
    shared: false,
    sharingMode: "private",
    allowedRecipientIds: [],
    decentralizedStorageStatus: "not_configured",
    decentralizedStorageProvider: "wallet-api"
  }
];

export const serviceMatches: ServiceMatch[] = [
  {
    id: "svc-1",
    name: "Emergency shelter sign-up",
    category: "Shelter",
    distance: "2.1 mi",
    availability: "Open tonight"
  },
  {
    id: "svc-2",
    name: "Benefits help clinic",
    category: "Benefits",
    distance: "Phone or walk-in",
    availability: "Weekdays"
  },
  {
    id: "svc-3",
    name: "Mobile health outreach",
    category: "Health",
    distance: "3.4 mi",
    availability: "Tomorrow"
  }
];

export const auditEvents: AuditEvent[] = [
  {
    id: "aud-1",
    actor: "You",
    action: "Reviewed emergency disclosure scopes",
    timestamp: "Today, 9:24 AM"
  },
  {
    id: "aud-2",
    actor: "System",
    action: "Check-in reminder scheduled",
    timestamp: "Yesterday, 6:00 PM"
  },
  {
    id: "aud-3",
    actor: "Shelter staff",
    action: "Assisted with contact verification",
    timestamp: "Apr 30, 2:10 PM"
  }
];

export const analyticsStudies: AnalyticsStudy[] = [
  {
    id: "study-1",
    title: "Unsheltered residents seeking beds",
    purpose: "Publish verified nightly shelter demand by county and need type without releasing row-level requests.",
    fields: ["county", "need_category", "age_group"],
    minCohortSize: 25,
    epsilonBudget: 1.5,
    spentBudget: 0.45,
    status: "available"
  },
  {
    id: "study-2",
    title: "Provider capacity gap alerts",
    purpose: "Publish where provider networks are full or building waitlists without exposing any program roster.",
    fields: ["county", "service_type"],
    minCohortSize: 20,
    epsilonBudget: 1.2,
    spentBudget: 0.3,
    status: "available"
  },
  {
    id: "study-3",
    title: "Housing placements after referral",
    purpose: "Publish how often verified referrals lead to housing placement at a safe group level.",
    fields: ["county", "housing_outcome"],
    minCohortSize: 30,
    epsilonBudget: 1,
    spentBudget: 0.2,
    status: "paused"
  },
  {
    id: "study-4",
    title: "Substance use treatment and recovery statistics",
    purpose: "Publish how many people start rehab intake and active recovery planning without exposing treatment records.",
    fields: ["county", "treatment_pathway", "referral_source"],
    minCohortSize: 18,
    epsilonBudget: 1.1,
    spentBudget: 0.26,
    status: "available"
  }
];

export const initialAccessRequests: WalletAccessRequest[] = [
  {
    id: "access-1",
    requesterName: "Benefits help clinic",
    requesterDid: "did:key:benefits-clinic",
    audienceDid: "did:key:benefits-clinic",
    resourceLabel: "Benefits letter",
    abilities: ["record/analyze"],
    purpose: "Check if you can get food, bill, or housing help",
    status: "pending",
    createdAt: "Today, 10:12 AM"
  },
  {
    id: "access-2",
    requesterName: "Downtown Outreach",
    requesterDid: "did:key:outreach",
    audienceDid: "did:key:outreach",
    resourceLabel: "State ID file",
    abilities: ["record/decrypt"],
    purpose: "Check your ID for shelter sign-up",
    status: "pending",
    createdAt: "Yesterday, 4:18 PM",
    approvalRequired: true,
    approvalThreshold: 2,
    approvalCount: 1
  },
  {
    id: "access-3",
    requesterName: "Legal Aid desk",
    requesterDid: "did:key:legal-aid",
    audienceDid: "did:key:legal-aid",
    resourceLabel: "Housing notice",
    abilities: ["record/analyze"],
    purpose: "Help plan an appeal",
    status: "approved",
    createdAt: "Apr 30, 3:05 PM",
    grantStatus: "active"
  }
];

export const initialGrantReceipts: WalletGrantReceipt[] = [
  {
    id: "receipt-1",
    grantId: "grant-legal-aid",
    audienceName: "Legal Aid desk",
    audienceDid: "did:key:legal-aid",
    resources: ["wallet://demo-wallet/records/rec-housing-notice"],
    recordId: "rec-housing-notice",
    resourceLabel: "Housing notice",
    abilities: ["record/analyze"],
    purpose: "Help plan an appeal",
    receiptHash: "8d2e31b4f7a9c6eab2d4f0c98a3e7b1f",
    status: "active",
    createdAt: "Apr 30, 3:05 PM",
    expiresAt: "May 30, 2026"
  }
];

const analyticsCountyProfiles = [
  { county: "multnomah", label: "Multnomah", scale: 1 },
  { county: "washington", label: "Washington", scale: 0.82 },
  { county: "clackamas", label: "Clackamas", scale: 0.67 },
  { county: "lane", label: "Lane", scale: 0.74 },
  { county: "marion", label: "Marion", scale: 0.71 }
];

const analyticsPopulationReleaseBatches = [
  { ageGroup: "adult_25_54", cohortLabel: "adult 25 to 54", cohortCount: 620, shelterRequests: 210, waitingOver7Days: 71 },
  { ageGroup: "family_household", cohortLabel: "family household", cohortCount: 390, shelterRequests: 95, waitingOver7Days: 29 },
  { ageGroup: "veteran_household", cohortLabel: "veteran household", cohortCount: 205, shelterRequests: 64, waitingOver7Days: 18 },
  { ageGroup: "youth_18_24", cohortLabel: "youth 18 to 24", cohortCount: 168, shelterRequests: 58, waitingOver7Days: 16 },
  { ageGroup: "senior_55_plus", cohortLabel: "senior 55 plus", cohortCount: 142, shelterRequests: 47, waitingOver7Days: 14 }
];

const analyticsProviderReleaseBatches = [
  {
    serviceType: "emergency_shelter",
    serviceLabel: "emergency shelter",
    providersIncluded: 4,
    occupiedBeds: 228,
    licensedBeds: 250,
    sameDayAvailablePrograms: 17,
    totalPrograms: 30
  },
  {
    serviceType: "transitional_housing",
    serviceLabel: "transitional housing",
    providersIncluded: 2,
    occupiedBeds: 41,
    licensedBeds: 56,
    sameDayAvailablePrograms: 4,
    totalPrograms: 8
  },
  {
    serviceType: "winter_shelter",
    serviceLabel: "winter shelter",
    providersIncluded: 3,
    occupiedBeds: 74,
    licensedBeds: 92,
    sameDayAvailablePrograms: 7,
    totalPrograms: 12
  },
  {
    serviceType: "recovery_beds",
    serviceLabel: "recovery beds",
    providersIncluded: 2,
    occupiedBeds: 38,
    licensedBeds: 52,
    sameDayAvailablePrograms: 5,
    totalPrograms: 9
  },
  {
    serviceType: "family_shelter",
    serviceLabel: "family shelter",
    providersIncluded: 3,
    occupiedBeds: 69,
    licensedBeds: 88,
    sameDayAvailablePrograms: 6,
    totalPrograms: 11
  }
];

const analyticsHousingReleaseBatches = [
  { housingOutcome: "placed", outcomeLabel: "placed", referralsCompleted: 120, housedReferrals: 50 },
  { housingOutcome: "rapid_rehousing", outcomeLabel: "rapid rehousing", referralsCompleted: 44, housedReferrals: 19 },
  {
    housingOutcome: "permanent_supportive_housing",
    outcomeLabel: "permanent supportive housing",
    referralsCompleted: 52,
    housedReferrals: 22
  },
  { housingOutcome: "family_reunification", outcomeLabel: "family reunification", referralsCompleted: 36, housedReferrals: 14 },
  { housingOutcome: "diversion", outcomeLabel: "diversion", referralsCompleted: 64, housedReferrals: 27 }
];

const analyticsOutreachReleaseBatches = [
  { serviceType: "street_outreach", serviceLabel: "street outreach", completedFollowups: 43, assignedFollowups: 63 },
  { serviceType: "hygiene_outreach", serviceLabel: "hygiene outreach", completedFollowups: 17, assignedFollowups: 24 },
  { serviceType: "medical_outreach", serviceLabel: "medical outreach", completedFollowups: 21, assignedFollowups: 33 },
  {
    serviceType: "encampment_resolution",
    serviceLabel: "encampment resolution",
    completedFollowups: 18,
    assignedFollowups: 29
  },
  {
    serviceType: "benefits_navigation",
    serviceLabel: "benefits navigation",
    completedFollowups: 16,
    assignedFollowups: 27
  }
];

const analyticsRecoveryReleaseBatches = [
  {
    treatmentPathway: "detox",
    pathwayLabel: "detox referrals",
    referralSource: "street_outreach",
    treatmentReferrals: 58,
    intakesCompleted: 36,
    activeRecoveryPlans: 31
  },
  {
    treatmentPathway: "residential_treatment",
    pathwayLabel: "residential treatment",
    referralSource: "emergency_shelter",
    treatmentReferrals: 47,
    intakesCompleted: 29,
    activeRecoveryPlans: 26
  },
  {
    treatmentPathway: "outpatient_treatment",
    pathwayLabel: "outpatient treatment",
    referralSource: "medical_outreach",
    treatmentReferrals: 66,
    intakesCompleted: 48,
    activeRecoveryPlans: 44
  },
  {
    treatmentPathway: "medication_assisted_treatment",
    pathwayLabel: "medication-assisted treatment",
    referralSource: "benefits_navigation",
    treatmentReferrals: 39,
    intakesCompleted: 30,
    activeRecoveryPlans: 27
  }
];

let analyticsProofSequence = 2;

function nextAnalyticsProofMetadata(prefix: string) {
  const sequence = analyticsProofSequence;
  analyticsProofSequence += 1;
  const day = 1 + Math.floor((sequence - 2) / 20);
  const hour = 8 + ((sequence - 2) % 5);
  const minute = String((10 + sequence * 7) % 60).padStart(2, "0");
  return {
    id: `proof-${sequence}`,
    verifierDigest: `${prefix}-${sequence}d64c5b78caa09fd67d24b099c1ca87`,
    proofArtifactRef: `zk-cert-${prefix}-${sequence}`,
    createdAt: `May ${day}, ${hour}:${minute} ${sequence % 2 === 0 ? "AM" : "PM"}`
  };
}

const analyticsProofReceipts: ProofReceiptView[] = [
  ...analyticsPopulationReleaseBatches.flatMap((batch, batchIndex) =>
    analyticsCountyProfiles.map((countyProfile) => {
      const cohortCount = Math.round(batch.cohortCount * countyProfile.scale) + batchIndex * 3;
      const shelterRequests = Math.round(batch.shelterRequests * countyProfile.scale) + batchIndex * 2;
      const waitingOver7Days = Math.max(1, Math.round(batch.waitingOver7Days * countyProfile.scale) + batchIndex);
      const metadata = nextAnalyticsProofMetadata("analytics-pop");
      return {
        ...metadata,
        proofType: "analytics_population_snapshot",
        claim: `Unsheltered residents seeking beds in ${countyProfile.county} county ${batch.cohortLabel} cohort`,
        verifier: `${countyProfile.label} release verifier`,
        proofSystem: "simulated_zk_certificate",
        verificationStatus: "verified",
        circuitId: "analytics-population-snapshot-v1",
        publicInputs: {
          certificate_type: "population_snapshot",
          study_id: "study-1",
          county: countyProfile.county,
          need_category: "shelter",
          age_group: batch.ageGroup,
          cohort_count: String(cohortCount),
          shelter_requests: String(shelterRequests),
          waiting_over_7_days: String(waitingOver7Days)
        },
        witnessLabel: "Derived shelter demand cohort",
        simulated: true
      };
    })
  ),
  ...analyticsProviderReleaseBatches.flatMap((batch, batchIndex) =>
    analyticsCountyProfiles.map((countyProfile) => {
      const providersIncluded = Math.max(2, Math.round(batch.providersIncluded * (countyProfile.scale + 0.15)));
      const occupiedBeds = Math.round(batch.occupiedBeds * countyProfile.scale) + batchIndex * 2;
      const licensedBeds = Math.max(
        occupiedBeds + 8,
        Math.round(batch.licensedBeds * (countyProfile.scale + 0.18)) + batchIndex * 3
      );
      const sameDayAvailablePrograms = Math.max(
        1,
        Math.round(batch.sameDayAvailablePrograms * (countyProfile.scale + 0.08)) + Math.floor(batchIndex / 2)
      );
      const totalPrograms = Math.max(
        sameDayAvailablePrograms + 1,
        Math.round(batch.totalPrograms * (countyProfile.scale + 0.12)) + batchIndex
      );
      const metadata = nextAnalyticsProofMetadata("analytics-cap");
      return {
        ...metadata,
        proofType: "analytics_provider_capacity",
        claim: `Provider capacity gap alerts in ${countyProfile.county} county ${batch.serviceLabel}`,
        verifier: `${countyProfile.label} provider verifier`,
        proofSystem: "simulated_zk_certificate",
        verificationStatus: "verified",
        circuitId: "analytics-provider-capacity-v1",
        publicInputs: {
          certificate_type: "provider_capacity",
          study_id: "study-2",
          county: countyProfile.county,
          service_type: batch.serviceType,
          providers_included: String(providersIncluded),
          occupied_beds: String(occupiedBeds),
          licensed_beds: String(licensedBeds),
          same_day_available_programs: String(sameDayAvailablePrograms),
          total_programs: String(totalPrograms)
        },
        witnessLabel: "Provider occupancy release batch",
        simulated: true
      };
    })
  ),
  ...analyticsHousingReleaseBatches.flatMap((batch, batchIndex) =>
    analyticsCountyProfiles.map((countyProfile) => {
      const referralsCompleted = Math.round(batch.referralsCompleted * countyProfile.scale) + batchIndex * 2;
      const housedReferrals = Math.min(
        referralsCompleted - 1,
        Math.round(batch.housedReferrals * countyProfile.scale) + batchIndex
      );
      const metadata = nextAnalyticsProofMetadata("analytics-house");
      return {
        ...metadata,
        proofType: "analytics_housing_outcome",
        claim: `Housing placements after referral in ${countyProfile.county} county ${batch.outcomeLabel} cohort`,
        verifier: `${countyProfile.label} housing verifier`,
        proofSystem: "simulated_zk_certificate",
        verificationStatus: "verified",
        circuitId: "analytics-housing-outcome-v1",
        publicInputs: {
          certificate_type: "housing_outcome",
          study_id: "study-3",
          county: countyProfile.county,
          housing_outcome: batch.housingOutcome,
          referrals_completed: String(referralsCompleted),
          housed_referrals: String(housedReferrals)
        },
        witnessLabel: "Referral outcome release batch",
        simulated: true
      };
    })
  ),
  ...analyticsOutreachReleaseBatches.flatMap((batch, batchIndex) =>
    analyticsCountyProfiles.map((countyProfile) => {
      const assignedFollowups = Math.round(batch.assignedFollowups * countyProfile.scale) + batchIndex * 2;
      const completedFollowups = Math.min(
        assignedFollowups - 1,
        Math.round(batch.completedFollowups * countyProfile.scale) + batchIndex
      );
      const metadata = nextAnalyticsProofMetadata("analytics-outreach");
      return {
        ...metadata,
        proofType: "analytics_outreach_followup",
        claim: `Street outreach follow-up rate in ${countyProfile.county} county ${batch.serviceLabel}`,
        verifier: `${countyProfile.label} outreach verifier`,
        proofSystem: "simulated_zk_certificate",
        verificationStatus: "verified",
        circuitId: "analytics-outreach-followup-v1",
        publicInputs: {
          certificate_type: "outreach_followup",
          study_id: "study-2",
          county: countyProfile.county,
          service_type: batch.serviceType,
          completed_followups: String(completedFollowups),
          assigned_followups: String(assignedFollowups)
        },
        witnessLabel: "Outreach follow-up release batch",
        simulated: true
      };
    })
  ),
  ...analyticsRecoveryReleaseBatches.flatMap((batch, batchIndex) =>
    analyticsCountyProfiles.map((countyProfile) => {
      const treatmentReferrals = Math.round(batch.treatmentReferrals * countyProfile.scale) + batchIndex * 2;
      const intakesCompleted = Math.min(
        treatmentReferrals - 1,
        Math.round(batch.intakesCompleted * countyProfile.scale) + batchIndex
      );
      const activeRecoveryPlans = Math.min(
        intakesCompleted - 1,
        Math.round(batch.activeRecoveryPlans * countyProfile.scale) + batchIndex
      );
      const metadata = nextAnalyticsProofMetadata("analytics-recovery");
      return {
        ...metadata,
        proofType: "analytics_recovery_outcome",
        claim: `Drug rehab intake outcomes in ${countyProfile.county} county ${batch.pathwayLabel}`,
        verifier: `${countyProfile.label} recovery verifier`,
        proofSystem: "simulated_zk_certificate",
        verificationStatus: "verified",
        circuitId: "analytics-recovery-outcome-v1",
        publicInputs: {
          certificate_type: "recovery_outcome",
          study_id: "study-4",
          county: countyProfile.county,
          treatment_pathway: batch.treatmentPathway,
          referral_source: batch.referralSource,
          treatment_referrals: String(treatmentReferrals),
          intakes_completed: String(intakesCompleted),
          active_recovery_plans: String(activeRecoveryPlans)
        },
        witnessLabel: "Recovery services release batch",
        simulated: true
      };
    })
  )
];

export const proofReceipts: ProofReceiptView[] = [
  {
    id: "proof-1",
    proofType: "location_region",
    claim: "Location is in service region",
    verifier: "211 service matcher",
    proofSystem: "simulated",
    verificationStatus: "verified",
    circuitId: "simulated-location-region",
    verifierDigest: "425551d64c5b78caa09fd67d24b099c1ca8749bc9747daa0ae84a69cf3507e3e",
    publicInputs: {
      region_id: "multnomah_county",
      claim: "location_in_region",
      region_policy_hash: "425551d64c5b78caa09fd67d24b099c1ca8749bc9747daa0ae84a69cf3507e3e"
    },
    witnessLabel: "Current location",
    simulated: true,
    createdAt: "Today, 10:38 AM"
  },
  ...analyticsProofReceipts
];

export const exportBundles: ExportBundleView[] = [
  {
    id: "export-1",
    bundleId: "export-6d8f4e92b1a7c340d57a92ce",
    bundleHash: "6d8f4e92b1a7c340d57a92ce90ef335aa64b85d62ef4d8e2b66a2010b16f5718",
    audienceName: "Legal Aid desk",
    recordCount: 2,
    proofCount: 1,
    verificationOk: true,
    hashOk: true,
    schemaOk: true,
    storageOk: true,
    imported: true,
    createdAt: "Today, 11:18 AM"
  },
  {
    id: "export-2",
    bundleId: "export-3a41c9fe8420d718ce1490b4",
    bundleHash: "3a41c9fe8420d718ce1490b45820ad275b01365f1d51287b27b835e192fc0062",
    audienceName: "Benefits help clinic",
    recordCount: 1,
    proofCount: 0,
    verificationOk: true,
    hashOk: true,
    schemaOk: true,
    storageOk: false,
    imported: false,
    createdAt: "Yesterday, 2:35 PM"
  }
];
