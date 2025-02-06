// IMPORTANT: Make sure to import `instrument.js` at the top of your file.
// If you're using ECMAScript Modules (ESM) syntax, use `import "./instrument.js";`
import { DefaultAzureCredential } from '@azure/identity';
import {
    AnonymousCredential,
    BlobSASPermissions,
    BlobServiceClient,
    generateBlobSASQueryParameters,
    newPipeline,
    PublicAccessType,
    StorageSharedKeyCredential,
} from '@azure/storage-blob';
import internal from 'stream';

type CommonConfig = {
    account: string;
    serviceBaseURL?: string;
    containerName: string;
    defaultPath: string;
    cdnBaseURL?: string;
    defaultCacheControl?: string;
    createContainerIfNotExist?: string;
    publicAccessType?: PublicAccessType;
    removeCN?: string;
    uploadOptions?: {
        bufferSize: number;
        maxBuffers: number;
    };
};

type Config = DefaultConfig | ManagedIdentityConfig;

type DefaultConfig = CommonConfig & {
    authType: 'default';
    accountKey: string;
    sasToken: string;
};

type ManagedIdentityConfig = CommonConfig & {
    authType: 'msi';
    accountKey: string;
    clientId?: string;
};

type StrapiFile = File & {
    stream: internal.Readable;
    hash: string;
    url: string;
    ext: string;
    mime: string;
    path: string;
};

function trimParam(input?: string) {
    return typeof input === 'string' ? input.trim() : '';
}

function getServiceBaseUrl(config: Config) {
    return (
        trimParam(config.serviceBaseURL) ||
        `https://${trimParam(config.account)}.blob.core.windows.net`
    );
}

function getFileName(path: string, file: StrapiFile) {
    return `${trimParam(path)}/${file.hash}${file.ext}`;
}

function makeBlobServiceClient(config: Config, file: StrapiFile) {
    const serviceBaseURL = getServiceBaseUrl(config);

    switch (config.authType) {
        case 'default': {
            const account = trimParam(config.account);
            const accountKey = trimParam(config.accountKey);
            const sasToken = trimParam(config.sasToken);
            const isPublic = file.hash.includes('public');
            if (sasToken != '' && !isPublic) {
                const anonymousCredential = new AnonymousCredential();
                return new BlobServiceClient(`${serviceBaseURL}${sasToken}`, anonymousCredential);
            }
            const sharedKeyCredential = new StorageSharedKeyCredential(account, accountKey);
            const pipeline = newPipeline(sharedKeyCredential);
            return new BlobServiceClient(serviceBaseURL, pipeline);
        }
        case 'msi': {
            const clientId = trimParam(config.clientId);
            if (clientId != null && clientId != '') {
                return new BlobServiceClient(
                    serviceBaseURL,
                    new DefaultAzureCredential({ managedIdentityClientId: clientId })
                );
            }
            return new BlobServiceClient(serviceBaseURL, new DefaultAzureCredential());
        }
        default: {
            const exhaustiveCheck: never = config;
            throw new Error(exhaustiveCheck);
        }
    }
}

const uploadOptions: CommonConfig['uploadOptions'] = {
    bufferSize: 4 * 1024 * 1024, // 4MB
    maxBuffers: 20,
};

async function handleUpload(
    config: Config,
    blobSvcClient: BlobServiceClient,
    file: StrapiFile
): Promise<void> {
    const serviceBaseURL = getServiceBaseUrl(config);
    const isPublic = file.hash.includes('public');
    const blobName = getFileName(config.defaultPath, file);
    const containerClient = blobSvcClient.getContainerClient(trimParam(config.containerName));
    const client = containerClient.getBlockBlobClient(getFileName(config.defaultPath, file));

    if (trimParam(config?.createContainerIfNotExist) === 'true') {
        if (
            trimParam(config?.publicAccessType) === 'container' ||
            trimParam(config?.publicAccessType) === 'blob'
        ) {
            await containerClient.createIfNotExists({
                access: config.publicAccessType,
            });
        } else {
            await containerClient.createIfNotExists();
        }
    }

    const options = {
        blobHTTPHeaders: {
            blobContentType: file.mime,
            blobCacheControl: trimParam(config.defaultCacheControl),
        },
    };

    // ✅ Generate SAS Token before upload
    const permissions = new BlobSASPermissions();
    permissions.read = true; // Allow read access only

    const expiryTime = isPublic
        ? new Date(new Date().setFullYear(new Date().getFullYear() + 10)) // 10 years for public files
        : new Date(new Date().valueOf() + 3600 * 1000);

    const cdnBaseURL = trimParam(config.cdnBaseURL);

    if (isPublic) {
        const sasToken = generateBlobSASQueryParameters(
            {
                containerName: config.containerName,
                blobName,
                permissions,
                expiresOn: expiryTime,
            },
            new StorageSharedKeyCredential(config.account, config.accountKey)
        ).toString();

        // ✅ Set the correct file URL before upload
        file.url = `${client.url}?${sasToken}`;
        file.url = cdnBaseURL ? client.url.replace(serviceBaseURL, cdnBaseURL) : file.url;
    } else {
        file.url = cdnBaseURL ? client.url.replace(serviceBaseURL, cdnBaseURL) : client.url;
    }

    if (
        file.url.includes(`/${config.containerName}/`) &&
        config.removeCN &&
        config.removeCN == 'true'
    ) {
        file.url = file.url.replace(`/${config.containerName}/`, '/');
    }

    await client.uploadStream(
        file.stream,
        (config.uploadOptions || uploadOptions)?.bufferSize,
        (config.uploadOptions || uploadOptions)?.maxBuffers,
        options
    );
}

async function handleDelete(
    config: Config,
    blobSvcClient: BlobServiceClient,
    file: StrapiFile
): Promise<void> {
    const containerClient = blobSvcClient.getContainerClient(trimParam(config.containerName));
    const client = containerClient.getBlobClient(getFileName(config.defaultPath, file));
    await client.delete();
    file.url = client.url;
}

module.exports = {
    provider: 'azure',
    auth: {
        authType: {
            label: 'Authentication type (required, either "msi" or "default")',
            type: 'text',
        },
        clientId: {
            label: 'Azure Identity ClientId (consumed if authType is "msi" and passed as DefaultAzureCredential({ managedIdentityClientId: clientId }))',
            type: 'text',
        },
        account: {
            label: 'Account name (required)',
            type: 'text',
        },
        accountKey: {
            label: 'Secret access key (required if authType is "default")',
            type: 'text',
        },
        serviceBaseURL: {
            label: 'Base service URL to be used, optional. Defaults to https://${account}.blob.core.windows.net (optional)',
            type: 'text',
        },
        containerName: {
            label: 'Container name (required)',
            type: 'text',
        },
        createContainerIfNotExist: {
            label: 'Create container on upload if it does not (optional)',
            type: 'text',
        },
        publicAccessType: {
            label: 'If createContainerIfNotExist is true, set the public access type to one of "blob" or "container" (optional)',
            type: 'text',
        },
        cdnBaseURL: {
            label: 'CDN base url (optional)',
            type: 'text',
        },
        defaultCacheControl: {
            label: 'Default cache-control setting for all uploaded files',
            type: 'text',
        },
        removeCN: {
            label: 'Remove container name from URL (optional)',
            type: 'text',
        },
    },
    init: (config: Config) => {
        return {
            upload(file: StrapiFile) {
                const blobSvcClient = makeBlobServiceClient(config, file);
                return handleUpload(config, blobSvcClient, file);
            },
            uploadStream(file: StrapiFile) {
                const blobSvcClient = makeBlobServiceClient(config, file);
                return handleUpload(config, blobSvcClient, file);
            },
            delete(file: StrapiFile) {
                const blobSvcClient = makeBlobServiceClient(config, file);
                return handleDelete(config, blobSvcClient, file);
            },
        };
    },
};
