import { seededIds } from "@veritymem/ledger";
const a = seededIds("ledgerbench:3:scopeA:tokenA:deletion/D01_erase_subject_zero_residual");
const b = seededIds("ledgerbench:3:scopeA:tokenB:deletion/D01_erase_subject_zero_residual");
console.log("tokenA first id:", a.next("evt"));
console.log("tokenB first id:", b.next("evt"));
console.log("tokenA second id:", a.next("evt"));
