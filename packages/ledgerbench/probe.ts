import { seededIds } from "@veritymem/ledger";
const ids = seededIds("ledgerbench:1:dbg-1789661241390:e65df355ace7ed24:deletion/D01_erase_subject_zero_residual");
console.log("evt:", ids.next("evt"));
console.log("cnd:", ids.next("cnd"));
console.log("spn:", ids.next("spn"));
console.log("dec:", ids.next("dec"));
