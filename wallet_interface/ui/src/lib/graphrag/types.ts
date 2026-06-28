export type SearchMode = "keyword" | "vector" | "hybrid";

export interface CorpusArtifact {
  path: string;
  bytes: number;
  cid: string;
  role: string;
}

export interface CorpusArtifactManifest {
  schemaVersion: number;
  datasetId: string;
  datasetPath: string;
  corpus: {
    name: string;
    source: string;
    documentCount: number;
    embeddingModel: string;
    embeddingDimension: number;
  };
  sourcePackage: {
    path: string;
    build_manifest_cid: string;
    document_count: number;
    graph_node_count: number;
    graph_edge_count: number;
  };
  artifacts: CorpusArtifact[];
}

export interface GeneratedCorpusManifest {
  schemaVersion: number;
  documentCount: number;
  serviceDocumentCount?: number;
  servicePhoneCount?: number;
  serviceAddressCount?: number;
  serviceIntakeStepCount?: number;
  serviceRequiredDocumentCount?: number;
  serviceLocationCount?: number;
  clusteredServiceLocationCount?: number;
  serviceLocationParquetRowGroupCount?: number;
  geoClusterCount?: number;
  geoClusteredServiceCount?: number;
  geoUnclusteredServiceCount?: number;
  documentParquetRowGroupCount?: number;
  geoRetrievalShardCount?: number;
  geoRetrievalShardContentCidCount?: number;
  bm25ParquetRowGroupCount?: number;
  embeddingParquetRowGroupCount?: number;
  graphGeoClusterCount?: number;
  graphCommunityParquetRowGroupCount?: number;
  documentCommunityParquetRowGroupCount?: number;
  embeddingCount: number;
  embeddingDimension: number;
  embeddingModel: string;
  bm25DocumentCount: number;
  graphNeighborhoodCount: number;
  graphNeighborhoodShardCount: number;
  graphCommunityCount: number;
  documentCommunityCount: number;
  geoSearchIndexedServiceCount?: number;
  geoSearchPlaceTermCount?: number;
  files: CorpusArtifact[];
}

export interface ParquetShardRecord {
  shardId: string;
  path: string;
  bytes: number;
  cid: string;
  sourcePath: string;
  sourceRowGroupIndex: number;
  sourceRowOffset: number;
  rowCount: number;
  clusterIds?: number[];
}

export interface ParquetShardArtifact {
  sourcePath: string;
  shardCount: number;
  shards: ParquetShardRecord[];
  docIdToShardIds?: Record<string, string[]>;
  contentCidToShardIds?: Record<string, string[]>;
  pageCidToShardIds?: Record<string, string[]>;
  clusterIdToShardIds?: Record<string, string[]>;
  serviceDocIdToShardIds?: Record<string, string[]>;
  communityIdToShardIds?: Record<string, string[]>;
}

export interface ParquetShardManifest {
  schemaVersion: number;
  maxRowsPerShard: number;
  basePath: string;
  shardCount: number;
  artifacts: Record<string, ParquetShardArtifact>;
}

export interface ServiceGeoPoint {
  lat?: number | null;
  lon?: number | null;
  precision?: string;
}

export interface ServiceContactPoint {
  contact_id?: string;
  label?: string;
  type?: string;
  value?: string;
  url?: string;
  tel_url?: string;
  sms_url?: string;
  confidence?: number;
}

export interface ServiceAddress {
  location_id?: string;
  label?: string;
  address?: string;
  street?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  maps_query?: string;
  google_maps_url?: string;
  apple_maps_url?: string;
  geo_url?: string;
  geo?: ServiceGeoPoint | null;
  confidence?: number;
}

export interface ServiceExtractValue {
  label?: string;
  value?: string;
  confidence?: number;
  extraction_method?: string;
  source_url?: string;
  source_content_cid?: string;
  source_page_cid?: string;
}

export interface CorpusDocument {
  doc_id: string;
  doc_type: string;
  title: string;
  text: string;
  text_truncated: boolean;
  source_url: string;
  source_content_cid: string;
  source_page_cid: string;
  provider_name: string;
  program_name: string;
  categories: string;
  host: string;
  city: string;
  state: string;
  geo_lat?: number | null;
  geo_lon?: number | null;
  geo_precision?: string;
  geo_cluster_id?: number | null;
  phones?: ServiceContactPoint[];
  emails?: ServiceContactPoint[];
  websites?: ServiceContactPoint[];
  addresses?: ServiceAddress[];
  hours?: ServiceExtractValue[];
  eligibility?: ServiceExtractValue[];
  intake_steps?: ServiceExtractValue[];
  required_documents?: ServiceExtractValue[];
  fees?: ServiceExtractValue[];
  languages?: ServiceExtractValue[];
  accessibility?: ServiceExtractValue[];
  travel_info?: ServiceExtractValue[];
  area_served?: ServiceExtractValue[];
  geo?: ServiceGeoPoint | null;
}

export interface CorpusDocumentIndex {
  schemaVersion: number;
  count: number;
  docIdToIndex: Record<string, number>;
  contentCidToIndex: Record<string, number>;
  contentCidToDocIds?: Record<string, string[]>;
}

export interface Bm25Document {
  doc_id: string;
  doc_type: string;
  source_url: string;
  source_content_cid: string;
  source_page_cid: string;
  document_length: number;
  terms: Record<string, number>;
  term_idf?: Record<string, number>;
}

export interface Bm25Payload {
  schemaVersion: number;
  documents: Bm25Document[];
  documentFrequency: Record<string, number>;
  k1: number;
  b: number;
  avgdl: number;
  documentCount: number;
  maxTermsPerDocument: number;
  sourceContentCidToDocIds?: Record<string, string[]>;
}

export interface EmbeddingIndex {
  schemaVersion: number;
  count: number;
  dimension: number;
  embeddingModel: string;
  browserEmbeddingModel: string;
  binary: string;
  parquet?: string;
  doc_ids: string[];
  source_content_cids: string[];
  source_page_cids: string[];
  source_urls: string[];
  sourceContentCidToDocIds?: Record<string, string[]>;
}

export interface GraphNode {
  node_id: string;
  node_type: string;
  label: string;
  [key: string]: string | number | boolean | null | undefined;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  edge_cid: string;
  bm25_score?: number;
  tf?: number;
  idf?: number;
  shared_document_count?: number;
  cooccurrence_score?: number;
  source_content_cid?: string;
}

export interface GraphNeighborhood {
  node_ids: string[];
  edge_ids: string[];
}

export interface GraphNeighborhoodShardRecord {
  id: string;
  path: string;
  bytes: number;
  cid: string;
  documentCount: number;
  nodeCount: number;
  edgeCount: number;
  firstDocId: string;
  lastDocId: string;
}

export interface GraphNeighborhoodIndex {
  schemaVersion: number;
  maxEdgesPerDocument: number;
  neighborhoodCount: number;
  shardSize: number;
  shardCount: number;
  shards: GraphNeighborhoodShardRecord[];
  docIdToShard: Record<string, string>;
}

export interface GraphNeighborhoodShard {
  schemaVersion: number;
  shardId: string;
  maxEdgesPerDocument: number;
  doc_ids: string[];
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge>;
  neighborhoods: Record<string, GraphNeighborhood>;
}

export interface GraphCommunity {
  community_id: string;
  community_cid: string;
  label: string;
  node_count: number;
  document_count: number;
  page_count: number;
  service_count: number;
  keyterm_count: number;
  provider_count: number;
  category_count: number;
  top_terms: Array<[string, number]>;
  top_categories: Array<[string, number]>;
  top_hosts: Array<[string, number]>;
}

export interface DocumentCommunity {
  doc_id: string;
  doc_type: string;
  source_url: string;
  source_content_cid: string;
  source_page_cid: string;
  community_id: string;
  community_label: string;
  geo_cluster_id?: number | null;
  geo_cluster_ids_json?: string;
  cluster_count?: number;
}

export interface SearchFilters {
  docTypes?: string[];
  city?: string;
  state?: string;
  host?: string;
  limit?: number;
}

export interface ServiceGeoIndex {
  schemaVersion: number;
  serviceCount: number;
  docsWithAddress: number;
  docsWithMapQuery: number;
  docsWithCoordinates: number;
  docsWithAreaServed: number;
  geoPrecisionCounts: Record<string, number>;
  docsByCity: Record<string, string[]>;
  docsByState: Record<string, string[]>;
  docsByPlaceTerm: Record<string, string[]>;
}

export interface ServiceLocationRecord {
  service_doc_id: string;
  location_id: string;
  label: string;
  address: string;
  street: string;
  city: string;
  state: string;
  postal_code: string;
  source_url: string;
  source_content_cid: string;
  source_page_cid: string;
  maps_query: string;
  apple_maps_url: string;
  google_maps_url: string;
  geo_url: string;
  geo_lat?: number | null;
  geo_lon?: number | null;
  geo_precision?: string;
  geo_cluster_id?: number | null;
  service_geo_cluster_id?: number | null;
}

export interface ServiceLocationIndex {
  schemaVersion: number;
  locationCount: number;
  clusteredLocationCount: number;
  unclusteredLocationCount: number;
  parquetPath: string;
  rowGroupCount: number;
  clusterIdToLocationRowGroupIndexes: Record<string, number[]>;
  clusterIdToLocationIds: Record<string, string[]>;
  contentCidToLocationIds: Record<string, string[]>;
  contentCidToClusterIds: Record<string, number[]>;
  docIdToLocationIds: Record<string, string[]>;
  docIdToClusterIds: Record<string, number[]>;
  locationIdToClusterId: Record<string, number | null>;
}

export interface SearchCoordinates {
  lat: number;
  lon: number;
}

export interface DocumentGeoClusterRecord {
  clusterId: number;
  kind: "service_cluster" | "service_unclustered";
  serviceDocumentCount: number;
  documentCount: number;
  centroid: {
    lat: number | null;
    lon: number | null;
  };
  bounds: {
    minLat: number | null;
    maxLat: number | null;
    minLon: number | null;
    maxLon: number | null;
  };
  topCities: Array<{ name: string; count: number }>;
  topStates: Array<{ name: string; count: number }>;
}

export interface DocumentGeoClusterRowGroup {
  rowGroupIndex: number;
  kind: "service_cluster" | "service_unclustered" | "non_service";
  clusterId: number | null;
  documentCount: number;
  serviceDocumentCount: number;
}

export interface DocumentGeoClusterManifest {
  schemaVersion: number;
  centroidSource: {
    kind: string;
    year: number;
    url: string;
    path: string;
  };
  serviceDocumentCount: number;
  clusteredServiceCount: number;
  unclusteredServiceCount: number;
  clusterCount: number;
  rowGroupCount?: number;
  nonServiceRowGroupCount?: number;
  serviceRowGroupCount?: number;
  clusters: DocumentGeoClusterRecord[];
  rowGroups?: DocumentGeoClusterRowGroup[];
  serviceDocIdToClusterId: Record<string, number>;
}

export interface RetrievalGeoShardRecord {
  shardId: string;
  clusterId: number;
  kind: "service_cluster" | "service_unclustered";
  documentCount: number;
  serviceDocumentCount: number;
  contentCidCount: number;
  firstDocId: string;
  lastDocId: string;
  bm25Path: string;
  embeddingIndexPath: string;
  embeddingBinaryPath: string;
  bm25ParquetPath?: string;
  embeddingParquetPath?: string;
  bm25RowGroupIndexes?: number[];
  embeddingRowGroupIndexes?: number[];
  sourceContentCidToDocIds?: Record<string, string[]>;
}

export interface RetrievalGeoShardManifest {
  schemaVersion: number;
  serviceDocumentCount: number;
  clusteredServiceCount: number;
  unclusteredServiceCount: number;
  embeddingModel: string;
  embeddingDimension: number;
  bm25ParquetPath?: string;
  embeddingParquetPath?: string;
  bm25RowGroupCount?: number;
  embeddingRowGroupCount?: number;
  clusterIdToBm25RowGroupIndexes?: Record<string, number[]>;
  clusterIdToEmbeddingRowGroupIndexes?: Record<string, number[]>;
  shardCount: number;
  shards: RetrievalGeoShardRecord[];
  clusterIdToShardId: Record<string, string>;
  docIdToShardId: Record<string, string>;
  contentCidToShardIds: Record<string, string[]>;
}

export interface GraphGeoClusterCommunitySummary {
  community_id: string;
  label: string;
  document_count: number;
  service_count: number;
  matched_documents: number;
}

export interface GraphGeoClusterRecord {
  clusterId: number;
  kind: string;
  serviceDocumentCount: number;
  graphDocumentCount: number;
  serviceGraphDocumentCount: number;
  pageGraphDocumentCount: number;
  graphNeighborhoodShardCount: number;
  graphNeighborhoodShardPaths: string[];
  communityCount: number;
  communityIds: string[];
  sourcePageCidCount: number;
  topCommunities: GraphGeoClusterCommunitySummary[];
}

export interface GraphGeoClusterManifest {
  schemaVersion: number;
  clusterCount: number;
  clusters: GraphGeoClusterRecord[];
  communityIdToClusterIds: Record<string, number[]>;
  docIdToClusterIds?: Record<string, number[]>;
}

export interface GraphCommunitySearchResult {
  community: GraphCommunity;
  clusterIds: number[];
  matchedTerms: string[];
  matchedDocIds: string[];
  score: number;
}

export interface GraphGeoClusterSearchResult {
  cluster: GraphGeoClusterRecord;
  matchedTerms: string[];
  matchedCommunityIds: string[];
  score: number;
}

export interface SearchResult {
  docId: string;
  contentCid: string;
  pageCid: string;
  document: CorpusDocument;
  score: number;
  duplicateCount?: number;
  mergedDocIds?: string[];
  distanceMiles?: number;
  scoreParts: {
    keyword: number;
    vector: number;
    metadata: number;
    proximity?: number;
  };
  snippet: string;
}

export interface GraphRagEvidence {
  query: string;
  results: SearchResult[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}
