const crypto = require('crypto');
const {
  calculateCrc32c,
  parseAndNormalizeDate,
  canonicalizeText,
  getWordSet,
  calculateJaccardSimilarity
} = require('./utils');

// UTF-8 byte comparison
function compareUtf8(strA, strB) {
  const bufA = Buffer.from(strA || "", "utf8");
  const bufB = Buffer.from(strB || "", "utf8");
  return Buffer.compare(bufA, bufB);
}

// Compare function for rejected objects
function compareRejectedObjects(a, b) {
  if (a.uri === null && b.uri !== null) return -1;
  if (a.uri !== null && b.uri === null) return 1;
  if (a.uri !== null && b.uri !== null && a.uri !== b.uri) {
    return compareUtf8(a.uri, b.uri);
  }
  return compareUtf8(JSON.stringify(a), JSON.stringify(b));
}

// Compare function for rejected rows
function compareRejectedRows(a, b) {
  const cmp = compareUtf8(a.id, b.id);
  if (cmp !== 0) return cmp;
  return compareUtf8(JSON.stringify(a), JSON.stringify(b));
}

// Compare function for lineage
function compareLineage(a, b) {
  const cmp = compareUtf8(a.uri, b.uri);
  if (cmp !== 0) return cmp;
  return compareUtf8(JSON.stringify(a), JSON.stringify(b));
}

function processCorpus(body) {
  const { policy, objects } = body;
  
  // 1. Policy Validity Check
  let policyValid = false;
  let minTime = null;
  let maxTime = null;
  let contaminationThreshold = 0;
  
  if (policy && typeof policy === 'object') {
    const normMin = parseAndNormalizeDate(policy.minTime);
    const normMax = parseAndNormalizeDate(policy.maxTime);
    const thresh = policy.contaminationThreshold;
    
    if (normMin && normMax && typeof thresh === 'number' && Number.isFinite(thresh) && thresh >= 0 && thresh <= 1) {
      policyValid = true;
      minTime = normMin;
      maxTime = normMax;
      contaminationThreshold = thresh;
    }
  }

  const rejectedObjects = [];
  const lineage = [];
  const retainedRows = []; // flat array of rows from accepted objects

  // 2. Process Objects
  for (const obj of objects) {
    const reasonCodes = new Set();
    const uri = obj.uri;
    const generation = obj.generation;
    const fetchedGeneration = obj.fetchedGeneration;
    const crc32cVal = obj.crc32c;
    const schemaId = obj.schemaId;
    const content = obj.content;

    // URI check
    if (typeof uri !== 'string' || !/^gs:\/\/[^\/]+\/.+$/.test(uri)) {
      reasonCodes.add('URI_INVALID');
    }

    // Generation check
    const isGenValid = typeof generation === 'string' && /^\d+$/.test(generation);
    const isFetchedGenValid = typeof fetchedGeneration === 'string' && /^\d+$/.test(fetchedGeneration);
    
    if (!isGenValid || !isFetchedGenValid) {
      reasonCodes.add('GENERATION_INVALID');
    }
    if (generation !== fetchedGeneration) {
      reasonCodes.add('GENERATION_MISMATCH');
    }

    // CRC32C check
    const isCrcSyntaxValid = typeof crc32cVal === 'string' && /^[0-9a-f]{8}$/.test(crc32cVal);
    if (!isCrcSyntaxValid) {
      reasonCodes.add('CRC32C_INVALID');
    } else if (typeof content === 'string') {
      const computedCrc = calculateCrc32c(Buffer.from(content, 'utf8'));
      if (computedCrc !== crc32cVal) {
        reasonCodes.add('CRC32C_MISMATCH');
      }
    }

    // Schema ID check
    if (schemaId !== 'training-v1') {
      reasonCodes.add('SCHEMA_INVALID');
    }

    // Content check
    if (typeof content !== 'string') {
      reasonCodes.add('SCHEMA_INVALID');
    } else {
      const lines = content.split(/\r?\n/);
      const nonBlankLines = lines.filter(line => line.trim() !== '');
      
      if (nonBlankLines.length === 0) {
        reasonCodes.add('SCHEMA_INVALID');
      } else {
        const parsedRows = [];
        let hasJsonError = false;
        let hasSchemaError = false;

        for (const line of nonBlankLines) {
          let parsedRow;
          try {
            parsedRow = JSON.parse(line);
          } catch (e) {
            hasJsonError = true;
            break;
          }

          if (!parsedRow || typeof parsedRow !== 'object' || Array.isArray(parsedRow)) {
            hasSchemaError = true;
            break;
          }

          const keys = Object.keys(parsedRow);
          if (keys.length !== 5 || !keys.includes('id') || !keys.includes('entity') || !keys.includes('eventTime') || !keys.includes('revision') || !keys.includes('text')) {
            hasSchemaError = true;
            break;
          }

          const { id, entity, eventTime, revision, text } = parsedRow;
          if (typeof id !== 'string' || typeof entity !== 'string' || typeof eventTime !== 'string' || typeof text !== 'string') {
            hasSchemaError = true;
            break;
          }

          if (!Number.isInteger(revision) || revision < 0 || !Number.isSafeInteger(revision)) {
            hasSchemaError = true;
            break;
          }

          const normEventTime = parseAndNormalizeDate(eventTime);
          if (!normEventTime) {
            hasSchemaError = true;
            break;
          }

          parsedRows.push({
            id,
            entity,
            eventTime,
            revision,
            text,
            normEventTime
          });
        }

        if (hasJsonError) {
          reasonCodes.add('JSONL_INVALID');
        } else if (hasSchemaError) {
          reasonCodes.add('SCHEMA_INVALID');
        } else {
          // Object is completely valid, cache rows for later processing
          obj.validRows = parsedRows;
        }
      }
    }

    if (reasonCodes.size > 0) {
      rejectedObjects.push({
        uri: typeof uri === 'string' ? uri : null,
        reasonCodes: Array.from(reasonCodes).sort(compareUtf8)
      });
    } else {
      lineage.push({
        uri,
        generation,
        crc32c: crc32cVal,
        schemaId
      });
      // Push valid rows into retainedRows
      for (const r of obj.validRows) {
        retainedRows.push({
          id: r.id,
          rawEntity: r.entity,
          rawEventTime: r.eventTime,
          revision: r.revision,
          rawText: r.text,
          normalizedEventTime: r.normEventTime,
          canonicalEntity: canonicalizeText(r.entity),
          canonicalText: canonicalizeText(r.text)
        });
      }
    }
  }

  // 3. Deduplication of Retained Rows
  // Group by JSON tuple [entity, eventTime, text] (canonicalized/normalized values)
  const groups = new Map();
  for (const row of retainedRows) {
    const key = JSON.stringify([row.canonicalEntity, row.normalizedEventTime, row.canonicalText]);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }

  const survivedDeduplication = [];
  const rejectedRowsMap = new Map(); // id -> Set of reason codes

  for (const [key, rows] of groups.entries()) {
    // Find winner: highest revision, tie-break by UTF-8-byte-smallest ID
    let winner = rows[0];
    for (let i = 1; i < rows.length; i++) {
      const current = rows[i];
      if (current.revision > winner.revision) {
        winner = current;
      } else if (current.revision === winner.revision) {
        if (compareUtf8(current.id, winner.id) < 0) {
          winner = current;
        }
      }
    }
    
    survivedDeduplication.push(winner);
    
    // All other rows are rejected as DUPLICATE
    for (const r of rows) {
      if (r !== winner) {
        if (!rejectedRowsMap.has(r.id)) {
          rejectedRowsMap.set(r.id, new Set());
        }
        rejectedRowsMap.get(r.id).add('DUPLICATE');
      }
    }
  }

  // 4. Policy/Window Filtering
  const survivedPolicy = [];
  for (const row of survivedDeduplication) {
    if (!policyValid) {
      if (!rejectedRowsMap.has(row.id)) {
        rejectedRowsMap.set(row.id, new Set());
      }
      rejectedRowsMap.get(row.id).add('POLICY_INVALID');
    } else {
      // check window
      // minTime and maxTime are normalized UTC strings, row.normalizedEventTime is normalized UTC string
      // lexical comparison works perfectly for normalized UTC strings of the same format YYYY-MM-DDTHH:mm:ss.sssZ
      if (row.normalizedEventTime < minTime || row.normalizedEventTime > maxTime) {
        if (!rejectedRowsMap.has(row.id)) {
          rejectedRowsMap.set(row.id, new Set());
        }
        rejectedRowsMap.get(row.id).add('OUT_OF_WINDOW');
      } else {
        survivedPolicy.push(row);
      }
    }
  }

  // 5. Split Routing
  const trainSplit = [];
  const validationCandidateSplit = [];
  const testCandidateSplit = [];

  for (const row of survivedPolicy) {
    const hash = crypto.createHash('sha256').update(row.canonicalEntity, 'utf8').digest();
    const firstByte = hash[0];
    const bucket = firstByte % 10;
    
    if (bucket >= 0 && bucket <= 5) {
      trainSplit.push(row);
    } else if (bucket === 6 || bucket === 7) {
      validationCandidateSplit.push(row);
    } else if (bucket === 8 || bucket === 9) {
      testCandidateSplit.push(row);
    }
  }

  // Cache train word sets for contamination checking
  const trainWordSets = trainSplit.map(row => getWordSet(row.canonicalText));

  // Contamination Check function
  function isContaminated(rowText, trainSets, threshold) {
    const valSet = getWordSet(rowText);
    for (const trainSet of trainSets) {
      const sim = calculateJaccardSimilarity(valSet, trainSet);
      if (sim >= threshold) {
        return true;
      }
    }
    return false;
  }

  const finalValidationSplit = [];
  const finalTestSplit = [];

  for (const row of validationCandidateSplit) {
    if (isContaminated(row.canonicalText, trainWordSets, contaminationThreshold)) {
      if (!rejectedRowsMap.has(row.id)) {
        rejectedRowsMap.set(row.id, new Set());
      }
      rejectedRowsMap.get(row.id).add('TRAIN_CONTAMINATION');
    } else {
      finalValidationSplit.push(row);
    }
  }

  for (const row of testCandidateSplit) {
    if (isContaminated(row.canonicalText, trainWordSets, contaminationThreshold)) {
      if (!rejectedRowsMap.has(row.id)) {
        rejectedRowsMap.set(row.id, new Set());
      }
      rejectedRowsMap.get(row.id).add('TRAIN_CONTAMINATION');
    } else {
      finalTestSplit.push(row);
    }
  }

  // 6. Serialization and Digests calculation
  function serializeAndDigestSplit(splitRows) {
    // Sort rows by UTF-8 bytes of ID, then break ties by compact JSON of the ordered row
    const sorted = [...splitRows].sort((a, b) => {
      const cmp = compareUtf8(a.id, b.id);
      if (cmp !== 0) return cmp;
      
      const orderedA = JSON.stringify({
        id: a.id,
        entity: a.canonicalEntity,
        eventTime: a.normalizedEventTime,
        revision: a.revision,
        text: a.canonicalText
      });
      const orderedB = JSON.stringify({
        id: b.id,
        entity: b.canonicalEntity,
        eventTime: b.normalizedEventTime,
        revision: b.revision,
        text: b.canonicalText
      });
      return compareUtf8(orderedA, orderedB);
    });

    const rowStrings = [];
    const jsonObjects = [];
    for (const r of sorted) {
      const ordered = {
        id: r.id,
        entity: r.canonicalEntity,
        eventTime: r.normalizedEventTime,
        revision: r.revision,
        text: r.canonicalText
      };
      rowStrings.push(JSON.stringify(ordered) + '\n');
      jsonObjects.push(ordered);
    }

    const splitContent = rowStrings.join('');
    const digest = crypto.createHash('sha256').update(splitContent, 'utf8').digest('hex');
    
    return {
      jsonObjects,
      digest
    };
  }

  const trainRes = serializeAndDigestSplit(trainSplit);
  const valRes = serializeAndDigestSplit(finalValidationSplit);
  const testRes = serializeAndDigestSplit(finalTestSplit);

  // Format Rejected Rows list
  const rejectedRows = [];
  for (const [id, codes] of rejectedRowsMap.entries()) {
    rejectedRows.push({
      id,
      reasonCodes: Array.from(codes).sort(compareUtf8)
    });
  }

  // Sort lists
  rejectedObjects.sort(compareRejectedObjects);
  rejectedRows.sort(compareRejectedRows);
  lineage.sort(compareLineage);

  return {
    splits: {
      train: trainRes.jsonObjects,
      validation: valRes.jsonObjects,
      test: testRes.jsonObjects
    },
    rejectedObjects,
    rejectedRows,
    digests: {
      train: trainRes.digest,
      validation: valRes.digest,
      test: testRes.digest
    },
    lineage
  };
}

module.exports = {
  processCorpus
};
