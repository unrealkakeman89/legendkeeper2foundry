console.error("Live acceptance is two separate gates. This command does not run either of them.");
console.error("Gate A, the API round trip: npm run live-api");
console.error("Gate B, the Foundry sheet test: npm run live-foundry");
console.error("A unit test or an HTTP connection is not either gate. Automatic sync stays off until both have passed.");
process.exit(2);
