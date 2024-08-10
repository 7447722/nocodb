import path from 'path';
import debug from 'debug';
import { UITypes } from 'nocodb-sdk';
import { Injectable } from '@nestjs/common';
import { FileReference, Source } from '~/models';
import NcPluginMgrv2 from '~/helpers/NcPluginMgrv2';
import Noco from '~/Noco';
import { MetaTable, RootScopes } from '~/utils/globals';
import NcConnectionMgrv2 from '~/utils/common/NcConnectionMgrv2';
import { Model } from '~/models';
import { extractProps } from '~/helpers/extractProps';
import mimetypes from '~/utils/mimeTypes';

@Injectable()
export class AttachmentMigration {
  private readonly debugLog = debug('nc:migration-jobs:attachment');

  log = (...msgs: string[]) => {
    console.log('[nc_job_001_attachment]: ', ...msgs);
  };

  async job() {
    try {
      const ncMeta = Noco.ncMeta;

      const temp_file_references_table = 'nc_temp_file_references';
      const temp_processed_models_table = 'nc_temp_processed_models';

      const fileReferencesTableExists =
        await ncMeta.knexConnection.schema.hasTable(temp_file_references_table);

      const processedModelsTableExists =
        await ncMeta.knexConnection.schema.hasTable(
          temp_processed_models_table,
        );

      if (!fileReferencesTableExists) {
        // create temp file references table if not exists
        await ncMeta.knexConnection.schema.createTable(
          temp_file_references_table,
          (table) => {
            table.increments('id').primary();
            table.text('file_path').notNullable();
            table.string('mimetype');
            table.boolean('referenced').defaultTo(false);
            table.boolean('thumbnail_generated').defaultTo(false);

            table.index('file_path');
          },
        );
      }

      if (!processedModelsTableExists) {
        // create temp processed models table if not exists
        await ncMeta.knexConnection.schema.createTable(
          temp_processed_models_table,
          (table) => {
            table.increments('id').primary();
            table.string('fk_model_id').notNullable();
            table.integer('offset').defaultTo(0);
            table.boolean('completed').defaultTo(false);

            table.index('fk_model_id');
          },
        );
      }

      // get all file references
      const storageAdapter = await NcPluginMgrv2.storageAdapter(ncMeta);

      const storageAdapterType = storageAdapter.name;

      const fileScanStream = await storageAdapter.scanFiles('nc/uploads/**');

      const fileReferenceBuffer = [];

      const insertPromises = [];

      let filesCount = 0;

      let err = null;

      fileScanStream.on('data', async (file) => {
        fileReferenceBuffer.push({ file_path: file });

        if (fileReferenceBuffer.length >= 100) {
          try {
            const processBuffer = fileReferenceBuffer.splice(0);

            filesCount += processBuffer.length;

            // skip or insert file references
            const toSkip = await ncMeta
              .knexConnection(temp_file_references_table)
              .whereIn(
                'file_path',
                fileReferenceBuffer.map((f) => f.file_path),
              );

            const toSkipPaths = toSkip.map((f) => f.file_path);

            const toInsert = processBuffer.filter(
              (f) => !toSkipPaths.includes(f.file_path),
            );

            if (toInsert.length > 0) {
              insertPromises.push(
                ncMeta
                  .knexConnection(temp_file_references_table)
                  .insert(toInsert)
                  .catch((e) => {
                    this.log(`Error inserting file references`);
                    this.log(e);
                    err = e;
                  }),
              );
            }

            this.log(`Scanned ${filesCount} files`);
          } catch (e) {
            this.log(`There was an error while scanning files`);
            this.log(e);
            err = e;
          }
        }
      });

      try {
        await new Promise((resolve, reject) => {
          fileScanStream.on('end', resolve);
          fileScanStream.on('error', reject);
        });

        await Promise.all(insertPromises);
      } catch (e) {
        this.log(`There was an error while scanning files`);
        this.log(e);
        throw e;
      }

      filesCount += fileReferenceBuffer.length;
      this.log(`Completed scanning with ${filesCount} files`);

      // throw if there was an async error while scanning files
      if (err) {
        throw err;
      }

      if (fileReferenceBuffer.length > 0) {
        await ncMeta
          .knexConnection(temp_file_references_table)
          .insert(fileReferenceBuffer);
      }

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const modelLimit = 100;

        let modelOffset = 0;

        const modelsWithAttachmentColumns = [];

        // get models that have at least one attachment column, and not processed

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const selectFields = [
            ...(Noco.isEE() ? ['fk_workspace_id'] : []),
            'base_id',
            'source_id',
            'fk_model_id',
          ];

          const models = await ncMeta
            .knexConnection(MetaTable.COLUMNS)
            .select(selectFields)
            .where('uidt', UITypes.Attachment)
            .whereNotIn(
              'fk_model_id',
              ncMeta
                .knexConnection(temp_processed_models_table)
                .select('fk_model_id')
                .where('completed', true),
            )
            .groupBy(selectFields)
            .limit(modelLimit)
            .offset(modelOffset);

          modelOffset += modelLimit;

          if (!models?.length) {
            break;
          }

          modelsWithAttachmentColumns.push(...models);
        }

        if (!modelsWithAttachmentColumns?.length) {
          break;
        }

        this.log(
          `Found ${modelsWithAttachmentColumns.length} models with attachment columns`,
        );

        let processedModelsCount = 0;

        for (const modelData of modelsWithAttachmentColumns) {
          const { fk_workspace_id, base_id, source_id, fk_model_id } =
            modelData;

          const context = {
            workspace_id: fk_workspace_id,
            base_id,
          };

          const source = await Source.get(context, source_id);

          if (!source) {
            this.log(`source not found for ${source_id}`);
            continue;
          }

          const model = await Model.get(context, fk_model_id);

          if (!model) {
            this.log(`model not found for ${fk_model_id}`);
            continue;
          }

          await model.getColumns(context);

          const attachmentColumns = model.columns.filter(
            (c) => c.uidt === UITypes.Attachment,
          );

          const dbDriver = await NcConnectionMgrv2.get(source);

          if (!dbDriver) {
            this.log(`connection can't achieved for ${source_id}`);
            continue;
          }

          const baseModel = await Model.getBaseModelSQL(context, {
            model,
            dbDriver,
          });

          const processedModel = await ncMeta
            .knexConnection(temp_processed_models_table)
            .where('fk_model_id', fk_model_id)
            .first();

          const dataLimit = 10;
          let dataOffset = 0;

          if (!processedModel) {
            await ncMeta
              .knexConnection(temp_processed_models_table)
              .insert({ fk_model_id, offset: 0 });
          } else {
            dataOffset = processedModel.offset;
          }

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const data = await baseModel.list(
              {
                fieldsSet: new Set(
                  model.primaryKeys
                    .map((c) => c.title)
                    .concat(attachmentColumns.map((c) => c.title)),
                ),
                sort: model.primaryKeys.map((c) => c.title),
                limit: dataLimit,
                offset: dataOffset,
              },
              {
                ignoreViewFilterAndSort: true,
              },
            );

            dataOffset += dataLimit;

            if (!data?.length) {
              break;
            }

            const updatePayload = [];

            for (const row of data) {
              const updateData = {};

              let updateRequired = false;

              for (const column of attachmentColumns) {
                let attachmentArr = row[column.title];

                if (!attachmentArr?.length) {
                  continue;
                }

                try {
                  if (typeof attachmentArr === 'string') {
                    attachmentArr = JSON.parse(attachmentArr);
                  }
                } catch (e) {
                  this.log(`error parsing attachment data ${attachmentArr}`);
                  continue;
                }

                if (Array.isArray(attachmentArr)) {
                  attachmentArr = attachmentArr.map((a) =>
                    extractProps(a, [
                      'id',
                      'url',
                      'path',
                      'title',
                      'mimetype',
                      'size',
                      'icon',
                      'width',
                      'height',
                    ]),
                  );

                  for (const attachment of attachmentArr) {
                    try {
                      if ('path' in attachment || 'url' in attachment) {
                        const filePath = `nc/uploads/${
                          attachment.path?.replace(/^download\//, '') ||
                          this.normalizeUrl(attachment.url)
                        }`;

                        const isReferenced = await ncMeta
                          .knexConnection(temp_file_references_table)
                          .where('file_path', filePath)
                          .first();

                        if (!isReferenced) {
                          // file is from another storage adapter
                          this.log(
                            `file not found in file references table ${
                              attachment.path || attachment.url
                            }, ${filePath}`,
                          );
                        } else if (isReferenced.referenced === false) {
                          const fileNameWithExt = path.basename(filePath);

                          const mimetype =
                            attachment.mimetype ||
                            mimetypes[path.extname(fileNameWithExt).slice(1)];

                          await ncMeta
                            .knexConnection(temp_file_references_table)
                            .where('file_path', filePath)
                            .update({
                              mimetype,
                              referenced: true,
                            });

                          // insert file reference if not exists
                          const fileReference = await ncMeta
                            .knexConnection(MetaTable.FILE_REFERENCES)
                            .where(
                              'file_url',
                              attachment.path || attachment.url,
                            )
                            .andWhere('storage', storageAdapterType)
                            .first();

                          if (!fileReference) {
                            await FileReference.insert(
                              {
                                workspace_id: RootScopes.ROOT,
                                base_id: RootScopes.ROOT,
                              },
                              {
                                storage: storageAdapterType,
                                file_url: attachment.path || attachment.url,
                                file_size: attachment.size,
                                deleted: true,
                              },
                            );
                          }
                        }

                        if (!('id' in attachment)) {
                          attachment.id = await FileReference.insert(context, {
                            source_id: source.id,
                            fk_model_id,
                            fk_column_id: column.id,
                            file_url: attachment.path || attachment.url,
                            file_size: attachment.size,
                            is_external: !source.isMeta(),
                            deleted: false,
                          });

                          updateRequired = true;
                        }
                      }
                    } catch (e) {
                      this.log(
                        `Error processing attachment ${JSON.stringify(
                          attachment,
                        )}`,
                      );
                      this.log(e);
                      throw e;
                    }
                  }
                }

                if (updateRequired) {
                  updateData[column.column_name] =
                    JSON.stringify(attachmentArr);
                }
              }

              if (Object.keys(updateData).length === 0) {
                continue;
              }

              for (const pk of model.primaryKeys) {
                updateData[pk.column_name] = row[pk.title];
              }

              updatePayload.push(updateData);
            }

            if (updatePayload.length > 0) {
              for (const updateData of updatePayload) {
                const wherePk = await baseModel._wherePk(
                  baseModel._extractPksValues(updateData),
                );

                if (!wherePk) {
                  this.log(`where pk not found for ${updateData}`);
                  continue;
                }

                await baseModel.execAndParse(
                  baseModel
                    .dbDriver(baseModel.tnPath)
                    .update(updateData)
                    .where(wherePk),
                  null,
                  {
                    raw: true,
                  },
                );
              }
            }

            // update offset
            await ncMeta
              .knexConnection(temp_processed_models_table)
              .where('fk_model_id', fk_model_id)
              .update({ offset: dataOffset });
          }

          // mark model as processed
          await ncMeta
            .knexConnection(temp_processed_models_table)
            .where('fk_model_id', fk_model_id)
            .update({ completed: true });

          processedModelsCount += 1;

          this.log(
            `Processed ${processedModelsCount} of ${modelsWithAttachmentColumns.length} models`,
          );
        }
      }
    } catch (e) {
      this.log(`There was an error while processing attachment migration job`);
      this.log(e);
      return false;
    }

    return true;
  }

  normalizeUrl(url: string) {
    const newUrl = new URL(encodeURI(url));
    return decodeURI(newUrl.pathname.replace(/.*?nc\/uploads\//, ''));
  }
}