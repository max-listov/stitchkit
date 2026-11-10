/** The support modules a fixture may import as `./<name>`. */
export declare const FIXTURE_SUPPORT_FILES: readonly string[];

/** Copy every support module into `directory`, the one holding the fixture's entry files. */
export declare function placeFixtureSupport(directory: string): void;
