#!/usr/bin/env node
/**
 * OpenAPI Spec Validator
 * Checks for common issues that prevent client generation
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

interface OpenAPISpec {
  openapi: string;
  info: any;
  paths: any;
  components?: {
    schemas?: Record<string, any>;
    [key: string]: any;
  };
  [key: string]: any;
}

class OpenAPIValidator {
  private spec: OpenAPISpec | null = null;
  private errors: string[] = [];
  private warnings: string[] = [];

  constructor(private specFile: string) {}

  loadSpec(): boolean {
    try {
      const content = fs.readFileSync(this.specFile, "utf8");

      if (this.specFile.endsWith(".yaml") || this.specFile.endsWith(".yml")) {
        this.spec = yaml.load(content) as OpenAPISpec;
      } else {
        this.spec = JSON.parse(content);
      }
      return true;
    } catch (error) {
      this.errors.push(`Failed to load spec file: ${error}`);
      return false;
    }
  }

  validateBasicStructure(): void {
    if (!this.spec) return;

    const requiredFields = ["openapi", "info", "paths"];
    for (const field of requiredFields) {
      if (!(field in this.spec)) {
        this.errors.push(`Missing required field: ${field}`);
      }
    }

    if ("openapi" in this.spec) {
      const version = this.spec.openapi;
      if (!version.startsWith("3.")) {
        this.warnings.push(
          `OpenAPI version ${version} might have compatibility issues`
        );
      }
    }
  }

  extractRefs(obj: any, refs: Set<string>, path: string = ""): void {
    if (obj && typeof obj === "object") {
      if (Array.isArray(obj)) {
        obj.forEach((item, i) => {
          this.extractRefs(item, refs, `${path}[${i}]`);
        });
      } else {
        for (const [key, value] of Object.entries(obj)) {
          if (key === "$ref" && typeof value === "string") {
            refs.add(value);
          } else {
            this.extractRefs(value, refs, `${path}.${key}`);
          }
        }
      }
    }
  }

  validateReferences(): void {
    if (!this.spec) return;

    // Extract all references
    const allRefs = new Set<string>();
    this.extractRefs(this.spec, allRefs);

    // Check each reference
    for (const ref of allRefs) {
      if (!ref.startsWith("#/")) {
        this.warnings.push(`External reference found: ${ref}`);
        continue;
      }

      // Remove the leading '#/' and split by '/'
      const refPath = ref.substring(2).split("/");

      // Navigate through the spec to check if reference exists
      let current: any = this.spec;
      for (let i = 0; i < refPath.length; i++) {
        const part = refPath[i];
        if (current && typeof current === "object" && part in current) {
          current = current[part];
        } else {
          this.errors.push(
            `Missing schema definition: ${ref} (failed at '${part}')`
          );
          break;
        }
      }
    }
  }

  validateDiscriminators(): void {
    if (!this.spec) return;

    const checkDiscriminators = (obj: any, path: string = ""): void => {
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        if ("discriminator" in obj && ("oneOf" in obj || "anyOf" in obj)) {
          const discriminator = obj.discriminator;
          if (
            typeof discriminator === "object" &&
            "propertyName" in discriminator
          ) {
            const propName = discriminator.propertyName;
            // Check if all schemas in oneOf/anyOf have the discriminator property
            const schemas = obj.oneOf || obj.anyOf || [];
            schemas.forEach((schema: any, i: number) => {
              if (
                schema &&
                typeof schema === "object" &&
                "properties" in schema
              ) {
                if (!(propName in (schema.properties || {}))) {
                  this.warnings.push(
                    `Discriminator property '${propName}' not found in schema at ${path}.oneOf[${i}]`
                  );
                }
              }
            });
          }
        }

        for (const [key, value] of Object.entries(obj)) {
          checkDiscriminators(value, `${path}.${key}`);
        }
      } else if (Array.isArray(obj)) {
        obj.forEach((item, i) => {
          checkDiscriminators(item, `${path}[${i}]`);
        });
      }
    };

    if (this.spec.components?.schemas) {
      checkDiscriminators(this.spec.components.schemas, "components.schemas");
    }
  }

  validateRequiredProperties(): void {
    if (!this.spec) return;

    const checkSchema = (schema: any, path: string): void => {
      if (
        schema &&
        typeof schema === "object" &&
        "required" in schema &&
        "properties" in schema
      ) {
        const required = schema.required;
        const properties = schema.properties;
        for (const prop of required) {
          if (!(prop in properties)) {
            this.errors.push(
              `Required property '${prop}' not defined in schema at ${path}`
            );
          }
        }
      }

      // Check nested schemas
      if (schema && typeof schema === "object" && "properties" in schema) {
        for (const [propName, propSchema] of Object.entries(
          schema.properties
        )) {
          if (propSchema && typeof propSchema === "object") {
            checkSchema(propSchema, `${path}.properties.${propName}`);
          }
        }
      }
    };

    if (this.spec.components?.schemas) {
      for (const [schemaName, schema] of Object.entries(
        this.spec.components.schemas
      )) {
        if (schema && typeof schema === "object") {
          checkSchema(schema, `components.schemas.${schemaName}`);
        }
      }
    }
  }

  checkUnusedSchemas(): void {
    if (!this.spec) return;

    // Get all defined schemas
    const definedSchemas = new Set<string>();
    if (this.spec.components?.schemas) {
      Object.keys(this.spec.components.schemas).forEach((key) =>
        definedSchemas.add(key)
      );
    }

    // Get all referenced schemas
    const allRefs = new Set<string>();
    this.extractRefs(this.spec, allRefs);

    const referencedSchemas = new Set<string>();
    for (const ref of allRefs) {
      if (ref.startsWith("#/components/schemas/")) {
        const schemaName = ref.split("/").pop();
        if (schemaName) {
          referencedSchemas.add(schemaName);
        }
      }
    }

    // Find unused schemas
    const unused = [...definedSchemas].filter(
      (schema) => !referencedSchemas.has(schema)
    );
    for (const schema of unused) {
      this.warnings.push(`Unused schema definition: ${schema}`);
    }
  }

  validate(): boolean {
    if (!this.loadSpec()) {
      return false;
    }

    console.log(`Validating OpenAPI spec: ${this.specFile}`);
    console.log("-".repeat(60));

    this.validateBasicStructure();
    this.validateReferences();
    this.validateDiscriminators();
    this.validateRequiredProperties();
    this.checkUnusedSchemas();

    // Print results
    if (this.errors.length > 0) {
      console.log(`\n❌ Found ${this.errors.length} error(s):`);
      for (const error of this.errors) {
        console.log(`  • ${error}`);
      }
    }

    if (this.warnings.length > 0) {
      console.log(`\n⚠️  Found ${this.warnings.length} warning(s):`);
      for (const warning of this.warnings) {
        console.log(`  • ${warning}`);
      }
    }

    if (this.errors.length === 0 && this.warnings.length === 0) {
      console.log("\n✅ OpenAPI spec is valid!");
    }

    console.log("\n" + "-".repeat(60));
    console.log(
      `Summary: ${this.errors.length} errors, ${this.warnings.length} warnings`
    );

    return this.errors.length === 0;
  }
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      "Usage: node validate-openapi.js <spec-file> [<spec-file>...]"
    );
    console.error("Options:");
    console.error("  --strict    Treat warnings as errors");
    process.exit(1);
  }

  const isStrict = args.includes("--strict");
  const specFiles = args.filter((arg) => arg !== "--strict");

  let allValid = true;

  for (const specFile of specFiles) {
    const validator = new OpenAPIValidator(specFile);
    const isValid = validator.validate();

    if (isStrict && validator["warnings"].length > 0) {
      allValid = false;
    } else {
      allValid = allValid && isValid;
    }

    console.log("\n");
  }

  process.exit(allValid ? 0 : 1);
}

// Run if called directly
if (require.main === module) {
  main();
}
